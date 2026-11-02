-- Database tests for Drive (20261028000300_drive.sql): only owners and admins who connect apps
-- install it, which makes Company files; the office keeps company folders (no two of a name in one
-- place, none inside itself, Company files where it is); a company file is the office's; putting a
-- file on a job by hand puts it at the job's property and tells the crew; a file whose client is
-- deleted goes in the Trash; files, single versions and folders go in the Trash and come back as
-- they were; nobody signed in sees what's in the Trash, changes it, or deletes a file or a stored
-- object; the stored files of everything else go in the Trash too, and photos and paperwork come
-- back on their visit or sub; the Trash shows each person what's theirs to see; and Drive's lists
-- and search.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tdr;
grant usage on schema tdr to authenticated, service_role;
create function tdr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tdr.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tdr.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
-- How many rows a statement changed (0 when row-level security hid every row from it).
create function tdr.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
-- Signs in as someone, for the rest of the transaction.
create function tdr.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- A storage path for one of the company's plan files.
create function tdr.path(p_company uuid, p_ext text default 'pdf') returns text language sql as $$
  select p_company || '/plans/' || gen_random_uuid() || '.' || p_ext
$$;
-- The stored files a purge or Delete forever hands over, in a line: "a+b" ("kept" for none).
create function tdr.files(p_paths text[]) returns text language sql as $$
  select coalesce(nullif(array_to_string(array(select p from unnest(p_paths) p order by p), '+'), ''), 'kept')
$$;
-- What in the Trash the person signed in can see by reading the tables (nothing, always).
create function tdr.trashed_seen() returns bigint language sql as $$
  select (select count(*) from public.plan_files where deleted_at is not null) + (select count(*) from public.drive_folders where deleted_at is not null)
$$;
grant execute on all functions in schema tdr to authenticated, service_role;

\set ann 'dd000000-0000-0000-0000-000000000001'
\set ola 'dd000000-0000-0000-0000-000000000002'
\set eve 'dd000000-0000-0000-0000-000000000003'
\set lou 'dd000000-0000-0000-0000-000000000004'
\set cy 'dd000000-0000-0000-0000-000000000005'
\set gus 'dd000000-0000-0000-0000-000000000006'
\set dot 'dd000000-0000-0000-0000-000000000007'
\set sal 'dd000000-0000-0000-0000-000000000008'
\set oz 'dd000000-0000-0000-0000-000000000009'

-- Ann owns Delta Roofing; Ola is office, Eve an estimator, Lou a crew lead, Cy field crew; Gus is an
-- admin whose role doesn't connect apps; Dot is office in a Dispatcher role (no subs, hiring or job
-- costs); Sal signs in for a sub. Oz owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'ann', 'ann@delta.test', '{"full_name": "Ann Owner"}'),
  (:'ola', 'ola@delta.test', '{"full_name": "Ola Office"}'),
  (:'eve', 'eve@delta.test', '{"full_name": "Eve Estimator"}'),
  (:'lou', 'lou@delta.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@delta.test', '{"full_name": "Cy Crew"}'),
  (:'gus', 'gus@delta.test', '{"full_name": "Gus Books"}'),
  (:'dot', 'dot@delta.test', '{"full_name": "Dot Dispatch"}'),
  (:'sal', 'sub-sal@subs.invalid', '{"full_name": "Sal Siding"}'),
  (:'oz', 'oz@other.test', '{"full_name": "Oz Other"}');
update auth.users set raw_app_meta_data = '{"crewtavo_sub": "delta:1"}' where id = :'sal';

begin;
set local role authenticated;
select tdr.as_user(:'oz');
select public.create_company('Other Roofing', 'roofing') as other \gset
commit;

begin;
set local role authenticated;
select tdr.as_user(:'ann');
select public.create_company('Delta Roofing', 'roofing') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports}') returning id as keeper \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Dispatcher', 'office', '{schedule,sales}') returning id as dispatcher \gset
insert into public.memberships (company_id, user_id, role) values
  (:'co', :'ola', 'office'), (:'co', :'eve', 'estimator'), (:'co', :'lou', 'crew_lead'), (:'co', :'cy', 'field_crew');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'gus', 'admin', :'keeper'), (:'co', :'dot', 'office', :'dispatcher');
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as c1 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c1', '14 Oak St') returning id as p1 \gset
insert into public.requests (company_id, client_id, property_id, title) values (:'co', :'c1', :'p1', 'Leak over the porch') returning id as r1 \gset
insert into public.quotes (company_id, client_id, property_id, title) values (:'co', :'c1', :'p1', 'New roof') returning id as q1 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'c1', :'p1', 'New roof') returning id as j1 \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bob Gone') returning id as c2 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c2', '9 Elm St') returning id as p2 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'c2', :'p2', 'Gutters') returning id as j2 \gset
insert into public.visits (company_id, job_id, property_id, title, starts_at, ends_at)
  values (:'co', :'j1', :'p1', 'Tear off', now() + interval '1 day', now() + interval '1 day 8 hours') returning id as v1 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v1', :'cy');
insert into public.subcontractors (company_id, name) values (:'co', 'Sal''s Siding') returning id as sub \gset
commit;
select number as j1_no from public.jobs where id = :'j1' \gset
select number as q1_no from public.quotes where id = :'q1' \gset
-- Sal's sign-in, as the server makes it, on the roof visit.
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', :'sub');
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v1', :'sal');
select private.drive_root_folder(:'other') as other_root \gset
select set_config('tdr.co', :'co', false);

\o
\echo 'Installing Drive'
\o /dev/null

-- ===== Install: owners and admins who connect apps ===========================================
begin;
set local role authenticated;
select tdr.as_user(:'ola');
select tdr.check(tdr.error_of(format('select public.drive_set_enabled(%L, true)', :'co')) = '42501: Only owners and admins who connect apps can install Drive',
  'office staff can''t install Drive');
select tdr.as_user(:'gus');
select tdr.expect_error(format('select public.drive_set_enabled(%L, true)', :'co'), 'nor an admin whose role doesn''t connect apps');
select tdr.as_user(:'oz');
select tdr.expect_error(format('select public.drive_set_enabled(%L, true)', :'co'), 'nor another business''s owner');
select tdr.as_user(:'ann');
select tdr.check(public.drive_set_enabled(:'co', true), 'the owner installs it');
select tdr.check((select (settings -> 'drive' ->> 'enabled')::boolean and settings -> 'drive' ? 'changed_at' from public.companies where id = :'co'),
  'installed in the company''s settings, with when');
select tdr.check((select count(*) = 1 and min(name) = 'Company files' from public.drive_folders where company_id = :'co' and parent_id is null), 'installing makes Company files');
select public.drive_set_enabled(:'co', false);
select tdr.check((select not (settings -> 'drive' ->> 'enabled')::boolean from public.companies where id = :'co'), 'the owner uninstalls it');
select public.drive_set_enabled(:'co', true);
select tdr.check((select count(*) = 1 from public.drive_folders where company_id = :'co'), 'uninstalling keeps Company files, and installing again doesn''t make another');
commit;
select id as root from public.drive_folders where company_id = :'co' and parent_id is null \gset

-- ===== Company folders ========================================================================
begin;
set local role authenticated;
select tdr.as_user(:'ola');
select tdr.check(public.drive_root(:'co') = :'root', 'drive_root gives the office Company files');
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'root', ' Forms ') returning id as forms \gset
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'forms', 'Insurance') returning id as insurance \gset
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'root', 'Price sheets') returning id as prices \gset
select tdr.check((select name = 'Forms' and created_by = :'ola' and deleted_at is null from public.drive_folders where id = :'forms'),
  'office staff make folders, the name trimmed, as themselves');
select tdr.check(tdr.error_of(format('insert into public.drive_folders (company_id, parent_id, name) values (%L, %L, %L)', :'co', :'root', 'FORMS'))
  = '23505: There''s already a folder called FORMS here.', 'two folders in one place can''t share a name, whatever the case');
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'insurance', 'Forms');
select tdr.check((select count(*) = 2 from public.drive_folders where name = 'Forms'), 'the same name in another folder is fine');
select tdr.expect_error(format('insert into public.drive_folders (company_id, parent_id, name) values (%L, %L, %L)', :'co', :'root', 'Bids/2026'), 'a name has no slashes');
select tdr.expect_error(format('insert into public.drive_folders (company_id, parent_id, name) values (%L, %L, %L)', :'co', :'root', '   '), 'or is empty');
select tdr.check(tdr.error_of(format('insert into public.drive_folders (company_id, name) values (%L, %L)', :'co', 'Second top'))
  = '22023: A folder goes inside Company files or another folder.', 'there''s one Company files');
select tdr.expect_error(format('insert into public.drive_folders (company_id, parent_id, name) values (%L, %L, %L)', :'co', :'other_root', 'Theirs'),
  'a folder goes in this company''s folders');
select tdr.check(tdr.error_of(format('update public.drive_folders set name = %L where id = %L', 'Stuff', :'root')) = '22023: Company files can''t be renamed or moved.',
  'Company files can''t be renamed');
select tdr.expect_error(format('update public.drive_folders set parent_id = %L where id = %L', :'forms', :'root'), 'or moved');
select tdr.check(tdr.error_of(format('update public.drive_folders set parent_id = %L where id = %L', :'insurance', :'forms'))
  = '22023: A folder can''t go inside itself or one of its own folders.', 'a folder can''t go inside one of its own');
select tdr.expect_error(format('update public.drive_folders set parent_id = %L where id = %L', :'forms', :'forms'), 'or inside itself');
select tdr.expect_error(format('update public.drive_folders set parent_id = null where id = %L', :'forms'), 'and every folder is inside another');
update public.drive_folders set name = 'Old price sheets', parent_id = :'forms' where id = :'prices';
select tdr.check((select name = 'Old price sheets' and parent_id = :'forms' from public.drive_folders where id = :'prices'), 'office staff rename and move folders');
update public.drive_folders set name = 'Price sheets', parent_id = :'root', created_by = :'ann' where id = :'prices';
select tdr.check((select created_by = :'ola' from public.drive_folders where id = :'prices'), 'who made it stays as it was');
commit;

-- Folders go 20 deep at most, Company files counted.
do $$
declare v uuid := (select id from public.drive_folders where company_id = current_setting('tdr.co')::uuid and parent_id is null);
begin
  for i in 1..19 loop
    insert into public.drive_folders (company_id, parent_id, name) values (current_setting('tdr.co')::uuid, v, 'Level ' || i) returning id into v;
  end loop;
  perform set_config('tdr.deepest', v::text, false);
end $$;
select tdr.check(tdr.error_of(format('insert into public.drive_folders (company_id, parent_id, name) values (%L, %L, %L)', :'co', current_setting('tdr.deepest'), 'Too deep'))
  = '22023: Folders go 20 deep at most. Put it somewhere higher up.', 'folders go 20 deep at most');
select tdr.expect_error(format('update public.drive_folders set parent_id = %L where id = %L', current_setting('tdr.deepest'), :'forms'),
  'and moving one with folders in it can''t take them deeper');
delete from public.drive_folders where name = 'Level 1';
select tdr.check((select count(*) = 0 from public.drive_folders where name like 'Level %'), '(the server deletes a folder with its folders)');

begin;
set local role authenticated;
select tdr.as_user(:'lou');
select tdr.check((select count(*) from public.drive_folders) = 0, 'a crew lead sees no folders');
select tdr.expect_error(format('insert into public.drive_folders (company_id, parent_id, name) values (%L, %L, %L)', :'co', :'root', 'Mine'), 'or makes one');
select tdr.check(tdr.error_of(format('select public.drive_root(%L)', :'co')) = '42501: Only the office can open Company files.', 'or opens Company files');
select tdr.as_user(:'oz');
select tdr.check((select count(*) from public.drive_folders where company_id = :'co') = 0, 'another business sees none of them');
commit;

\o
\echo 'Company files'
\o /dev/null

-- ===== Company files: in a folder, on no client ===============================================
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.plan_files (company_id, folder_id, title, path, file_name, crew_visible)
  values (:'co', :'forms', 'W-9 form', tdr.path(:'co'), 'w9.pdf', false) returning id as w9 \gset
select tdr.check((select folder_id = :'forms' and property_id is null and job_id is null and deleted_at is null from public.plan_files where id = :'w9'),
  'the office adds a file to a company folder, on no client');
insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (:'co', :'w9', 'W-9 form', tdr.path(:'co'), 'w9 2026.pdf') returning id as w9b \gset
select tdr.check((select folder_id = :'forms' and replaces_id = :'w9' from public.plan_files where id = :'w9b'), 'a new version stays in its folder');
insert into public.plan_files (company_id, folder_id, title, path, file_name, crew_visible, deleted_at, deleted_by, trashed_from)
  values (:'co', :'root', 'Price sheet', tdr.path(:'co'), 'prices.pdf', true, now(), :'ola', :'w9') returning id as sheet \gset
select tdr.check((select deleted_at is null and deleted_by is null and trashed_from is null from public.plan_files where id = :'sheet'), 'nothing is added straight into the Trash');
insert into public.plan_files (company_id, folder_id, title, path, file_name, crew_visible) values (:'co', :'prices', 'Spec book', tdr.path(:'co'), 'spec.pdf', false) returning id as spec \gset
insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (:'co', :'spec', 'Spec book', tdr.path(:'co'), 'spec b.pdf') returning id as spec2 \gset
select tdr.check(tdr.error_of(format('insert into public.plan_files (company_id, title, path, file_name) values (%L, %L, %L, %L)', :'co', 'Loose', tdr.path(:'co'), 'x.pdf'))
  = '23514: A file goes on a property, a request, a quote or a job', 'a file on nothing and in no folder is refused, as before');
select tdr.expect_error(format('insert into public.plan_files (company_id, folder_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'other_root', 'Theirs', tdr.path(:'co'), 'x.pdf'),
  'not in another company''s folder');
commit;

begin;
set local role authenticated;
select tdr.as_user(:'lou');
select tdr.check(tdr.error_of(format('insert into public.plan_files (company_id, folder_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'root', 'Mine', tdr.path(:'co'), 'mine.pdf'))
  = '23514: A file goes on a property, a request, a quote or a job', 'a crew lead can''t add a company file');
insert into public.plan_files (company_id, job_id, title, path, file_name, content_type) values (:'co', :'j1', 'Field sketch', tdr.path(:'co', 'jpg'), 'sketch.jpg', 'image/jpeg') returning id as sketch \gset
select tdr.check((select property_id = :'p1' from public.plan_files where id = :'sketch'), 'but adds files to a job as before');
select tdr.check((select count(*) from public.plan_files where id = :'sheet') = 1 and (select count(*) from public.plan_files where id = :'w9') = 0,
  'and sees company files marked for the crew, not the office''s');
commit;
-- The server, with no one signed in (a Google Drive import goes through the person's own sign-in).
insert into public.plan_files (company_id, folder_id, title, path, file_name, created_by) values (:'co', :'root', 'Imported', tdr.path(:'co'), 'imported.pdf', null) returning id as imported \gset
select tdr.check((select folder_id = :'root' from public.plan_files where id = :'imported'), 'the server adds company files too');

-- ===== Putting a file on a job by hand, and moving it ========================================
begin;
set local role authenticated;
select tdr.as_user(:'ola');
update public.plan_files set job_id = :'j1' where id = :'sheet';
select tdr.check((select property_id = :'p1' and job_id = :'j1' and folder_id = :'root' from public.plan_files where id = :'sheet'),
  'putting a company file on a job puts it at the job''s property, and it stays in its folder');
update public.plan_files set quote_id = :'q1' where id = :'spec2';
select tdr.check((select count(*) from public.plan_files where id in (:'spec', :'spec2') and quote_id = :'q1' and property_id = :'p1') = 2,
  'putting the newest version on a quote puts every version there');
update public.plan_files set folder_id = :'forms' where id = :'spec2';
select tdr.check((select count(*) from public.plan_files where id in (:'spec', :'spec2') and folder_id = :'forms') = 2, 'and moving it to another folder moves them all');
update public.plan_files set quote_id = null, property_id = null, folder_id = :'prices' where id = :'spec';
select tdr.check((select count(*) from public.plan_files where id in (:'spec', :'spec2') and quote_id is null and folder_id = :'prices') = 2, 'whichever version it''s done to');
select tdr.check(tdr.error_of(format('update public.plan_files set folder_id = null where id = %L', :'imported'))
  = '23514: A file goes on a property, a request, a quote or a job, or in a folder. Move it to the Trash instead.',
  'taking a file off everything by hand is refused: it goes in the Trash instead');
select tdr.expect_error(format('update public.plan_files set folder_id = %L where id = %L', :'other_root', :'imported'), 'it can''t move to another company''s folder');
commit;
select tdr.check((select count(*) from public.notifications where user_id = :'cy' and body like '%Price sheet added to job #' || :'j1_no' || '%') = 1,
  'the crew on the job''s upcoming visit hears about the file put on it');
select tdr.check((select count(*) from public.notifications where body like '%Spec book%') = 0, 'not about an office-only one');

begin;
set local role authenticated;
select tdr.as_user(:'lou');
select tdr.check(tdr.error_of(format('update public.plan_files set folder_id = %L where id = %L', :'forms', :'sheet')) = '42501: Only the office moves files between folders.',
  'a crew lead can''t move a file between folders');
rollback;

\o
\echo 'The Trash'
\o /dev/null

-- ===== A client deleted: its files go in the Trash ============================================
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j2', 'Gutter plan', tdr.path(:'co'), 'gutters.pdf') returning id as gutter \gset
insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (:'co', :'gutter', 'Gutter plan', tdr.path(:'co'), 'gutters b.pdf') returning id as gutter2 \gset
commit;
begin;
set local role authenticated;
select tdr.as_user(:'ann');
delete from public.clients where id = :'c2';
select tdr.check((select count(*) from public.plan_files where id in (:'gutter', :'gutter2')) = 0, 'deleting a client: the files on its job are out of sight');
select tdr.check((select count(*) from public.drive_trash(:'co') where kind = 'file' and id = :'gutter2' and versions = 2 and detail = 'What it was on was deleted') = 1,
  'and in the Trash, both versions as one file');
commit;
select tdr.check((select count(*) = 2 and bool_and(deleted_by = :'ann' and job_id is null and property_id is null) and count(distinct deleted_at) = 1
  from public.plan_files where id in (:'gutter', :'gutter2')), 'not gone: moved there together, by whoever deleted the client');

-- ===== A file, a version ======================================================================
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'Site plan', tdr.path(:'co'), 'site.pdf') returning id as site \gset
insert into public.plan_files (company_id, replaces_id, title, revision, path, file_name) values (:'co', :'site', 'Site plan', 'Rev B', tdr.path(:'co'), 'site b.pdf') returning id as site2 \gset
select tdr.check(public.drive_trash_file(:'site') = 2, 'moving a file to the Trash takes every version, whichever is asked for');
select tdr.check((select count(*) from public.plan_files where id in (:'site', :'site2')) = 0, 'they''re out of sight, even to the office');
select tdr.check((select count(*) from public.drive_trash(:'co') where kind = 'file' and id = :'site2' and versions = 2 and name = 'Site plan'
    and detail = 'Job #' || :'j1_no' || ' · 14 Oak St' and deleted_by = :'ola' and deleted_by_name = 'Ola Office' and purge_at = deleted_at + interval '30 days') = 1,
  'the Trash lists it once, by its newest version: where it was, who moved it there, and when it goes for good');
select tdr.check(tdr.error_of(format('insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'site2', 'Site plan', tdr.path(:'co'), 'c.pdf'))
  = '22023: That file is in the Trash. Restore it first.', 'no new version of a file in the Trash');
select tdr.expect_error(format('select public.drive_trash_file(%L)', :'site'), 'and it can''t go in the Trash twice');
select tdr.check(public.drive_restore('file', :'site2') = 'restored', 'restoring it');
select tdr.check((select count(*) from public.plan_files where id in (:'site', :'site2') and job_id = :'j1') = 2
  and (select replaces_id = :'site' and superseded_at is null from public.plan_files where id = :'site2'), 'brings back every version, as they were');
select tdr.expect_error(format('select public.drive_restore(%L, %L)', 'file', :'site2'), 'what isn''t in the Trash can''t be restored');

select tdr.check(public.drive_trash_version(:'site2') = :'site', 'the newest version goes in the Trash on its own');
select tdr.check((select superseded_at is null from public.plan_files where id = :'site'), 'and the one before is the current one again');
select tdr.check((select count(*) from public.drive_trash(:'co') where kind = 'version' and id = :'site2' and detail = 'Newest version · Job #' || :'j1_no' || ' · 14 Oak St') = 1,
  'the Trash lists the version');
select tdr.check(public.drive_restore('version', :'site2') = 'restored', 'restoring it');
select tdr.check((select replaces_id = :'site' and trashed_from is null and superseded_at is null from public.plan_files where id = :'site2')
  and (select superseded_at is not null from public.plan_files where id = :'site'), 'while the one before is still the newest: it''s the newest version again');
select tdr.check(tdr.error_of(format('select public.drive_trash_version(%L)', :'site')) = '22023: Only the newest version can go in the Trash on its own.',
  'an older version doesn''t go on its own');
select tdr.check(tdr.error_of(format('select public.drive_trash_version(%L)', :'sheet')) = '22023: This is the only version. Move the whole file to the Trash instead.',
  'nor does a file''s only version');

select public.drive_trash_version(:'site2');
insert into public.plan_files (company_id, replaces_id, title, revision, path, file_name) values (:'co', :'site', 'Site plan', 'Rev C', tdr.path(:'co'), 'site c.pdf') returning id as site3 \gset
select public.drive_restore('version', :'site2');
select tdr.check((select replaces_id is null and trashed_from is null and job_id = :'j1' and superseded_at is null from public.plan_files where id = :'site2')
  and (select replaces_id = :'site' and superseded_at is null from public.plan_files where id = :'site3'), 'once a newer version took its place, it comes back as a file of its own');
update public.plan_files set title = 'Site plan (Rev B)' where id = :'site2';
commit;

-- The crew lead: their own files only, and putting back what they moved there.
begin;
set local role authenticated;
select tdr.as_user(:'lou');
select tdr.check(tdr.error_of(format('select public.drive_trash_file(%L)', :'sheet'))
  = '42501: Only the office, or the crew lead who added every version of it, can move this file to the Trash.', 'a crew lead can''t move the office''s file to the Trash');
select tdr.check(public.drive_trash_file(:'sketch') = 1, 'but moves one they added');
select tdr.check((select array_agg(id) from public.drive_trash(:'co')) = array[:'sketch']::uuid[], 'and their Trash shows only what they moved there');
select tdr.check(public.drive_restore('file', :'sketch') = 'restored', 'and they put it back');
commit;
begin;
set local role authenticated;
select tdr.as_user(:'ola');
select public.drive_trash_file(:'sketch');
select tdr.as_user(:'lou');
select tdr.check(tdr.error_of(format('select public.drive_restore(%L, %L)', 'file', :'sketch')) = '42501: Only the office, or whoever moved it to the Trash, can restore it.',
  'a crew lead can''t restore what the office moved there');
select tdr.as_user(:'cy');
select tdr.expect_error(format('select public.drive_trash_file(%L)', :'sheet'), 'the crew can''t move files to the Trash');
select tdr.expect_error(format('select public.drive_trash_version(%L)', :'site3'), 'or versions');
select tdr.as_user(:'oz');
select tdr.check(tdr.error_of(format('select public.drive_trash_file(%L)', :'sheet')) = '22023: That file wasn''t found. It may already be in the Trash.',
  'another business finds nothing to move');
select tdr.check(not exists (select 1 from public.drive_trash(:'co')), 'or see');
rollback;

-- ===== Folders ================================================================================
begin;
set local role authenticated;
select tdr.as_user(:'ola');
select tdr.check(public.drive_trash_folder(:'forms') = 2, 'a folder goes in the Trash with its folders and the files in them (every version)');
select tdr.check((select count(*) from public.drive_folders where id in (:'forms', :'insurance')) = 0 and (select count(*) from public.plan_files where id in (:'w9', :'w9b')) = 0,
  'all out of sight');
select tdr.check((select array_agg(name) from public.drive_trash(:'co') where kind = 'folder') = '{Forms}'
  and not exists (select 1 from public.drive_trash(:'co') where id in (:'w9', :'w9b', :'insurance')), 'the Trash lists the folder, not what went with it');
select tdr.check((select detail = 'Company files' and versions = 1 from public.drive_trash(:'co') where id = :'forms'), 'saying where it was and how many files went with it');
select tdr.expect_error(format('insert into public.plan_files (company_id, folder_id, title, path, file_name) values (%L, %L, %L, %L, %L)', :'co', :'forms', 'Late', tdr.path(:'co'), 'late.pdf'),
  'nothing new goes into a folder in the Trash');
select tdr.expect_error(format('update public.plan_files set folder_id = %L where id = %L', :'forms', :'imported'), 'or moves into one');
select tdr.expect_error(format('insert into public.drive_folders (company_id, parent_id, name) values (%L, %L, %L)', :'co', :'forms', 'Late'), 'nor does a folder');
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'root', 'forms') returning id as forms_new \gset
select tdr.check(public.drive_restore('folder', :'forms') = 'restored', 'restoring the folder');
select tdr.check((select name = 'Forms (restored)' and parent_id = :'root' from public.drive_folders where id = :'forms'),
  'next to a new folder of the same name, it''s "Forms (restored)"');
select tdr.check((select count(*) from public.drive_folders where id = :'insurance' and parent_id = :'forms') = 1
  and (select count(*) from public.plan_files where id in (:'w9', :'w9b') and folder_id = :'forms') = 2, 'with its folders and files');
select tdr.check(tdr.error_of(format('select public.drive_trash_folder(%L)', :'root')) = '22023: Company files can''t go in the Trash.', 'Company files can''t go in the Trash');
select public.drive_trash_folder(:'insurance');
commit;

-- A folder whose own folder went in the Trash after it comes back in Company files; so does a file
-- from a folder in the Trash.
begin;
set local role authenticated;
select tdr.as_user(:'ola');
select public.drive_trash_folder(:'forms');
commit;
begin;
set local role authenticated;
select tdr.as_user(:'ola');
select tdr.check((select array_agg(name order by name) from public.drive_trash(:'co') where kind = 'folder') = '{"Forms (restored)",Insurance}',
  'the Trash lists both, each moved there itself');
select public.drive_restore('folder', :'insurance');
select tdr.check((select parent_id = :'root' and name = 'Insurance' from public.drive_folders where id = :'insurance'),
  'a folder whose folder is in the Trash comes back in Company files');
select public.drive_restore('file', :'w9');
select tdr.check((select count(*) from public.plan_files where id in (:'w9', :'w9b') and folder_id = :'root') = 2, 'and so does a file from a folder in the Trash');
commit;

begin;
set local role authenticated;
select tdr.as_user(:'eve');
select tdr.check(public.drive_trash_folder(:'forms_new') = 0, 'estimators keep folders too');
select tdr.as_user(:'lou');
select tdr.expect_error(format('select public.drive_trash_folder(%L)', :'prices'), 'a crew lead doesn''t');
rollback;

-- ===== What's in the Trash stays out of sight, and as it is ====================================
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'Roof plan', tdr.path(:'co'), 'roof.pdf') returning id as roof \gset
commit;
select path as roof_path from public.plan_files where id = :'roof' \gset
insert into storage.objects (bucket_id, name, owner) values ('files', :'roof_path', :'ola'),
  ('files', :'co' || '/visit/' || :'v1' || '/dd000000-0000-0000-0000-0000000000a1.jpg', :'cy');
begin;
set local role authenticated;
select tdr.as_user(:'sal');
select tdr.check((select count(*) from public.plan_files where id = :'roof') = 1 and (select count(*) from storage.objects where name = :'roof_path') = 1,
  'a sub on the job sees its plan and opens its file');
select tdr.as_user(:'ola');
select public.drive_trash_file(:'roof');
select tdr.as_user(:'sal');
select tdr.check((select count(*) from public.plan_files where id = :'roof') = 0 and (select count(*) from storage.objects where name = :'roof_path') = 0,
  'once it''s in the Trash, the sub sees neither');
commit;
begin;
set local role authenticated;
select tdr.as_user(:'ann');
select tdr.check(tdr.trashed_seen() = 0, 'nobody signed in sees what''s in the Trash: not the owner');
select tdr.as_user(:'ola');
select tdr.check(tdr.trashed_seen() = 0, 'office staff');
select tdr.as_user(:'lou');
select tdr.check(tdr.trashed_seen() = 0, 'crew leads');
select tdr.as_user(:'cy');
select tdr.check(tdr.trashed_seen() = 0, 'the crew');
select tdr.as_user(:'sal');
select tdr.check(tdr.trashed_seen() = 0, 'or subs');
commit;
select tdr.check((select count(*) from public.plan_files where deleted_at is not null) >= 3, '(though there is some)');

begin;
set local role authenticated;
select tdr.as_user(:'ola');
update public.plan_files set deleted_at = now(), deleted_by = :'ola', trashed_from = :'site' where id = :'sheet';
select tdr.check((select deleted_at is null and deleted_by is null and trashed_from is null from public.plan_files where id = :'sheet'), 'nobody moves a file to the Trash by hand');
update public.drive_folders set deleted_at = now(), deleted_by = :'ola' where id = :'prices';
select tdr.check((select deleted_at is null and deleted_by is null from public.drive_folders where id = :'prices'), 'or a folder');
select tdr.check(tdr.changed(format('update public.plan_files set title = %L', 'Renamed in the Trash')) = (select count(*) from public.plan_files),
  'an update without a filter changes only what''s in sight');
select tdr.check(tdr.changed(format('update public.plan_files set deleted_at = null where id = %L', :'roof')) = 0, 'and nobody takes a file out of the Trash by hand');
select tdr.check(tdr.changed(format('delete from public.plan_files where id = %L', :'sheet')) = 0 and tdr.changed(format('delete from public.drive_folders where id = %L', :'prices')) = 0,
  'nobody signed in deletes a file or a folder');
rollback;
select tdr.check((select title = 'Roof plan' from public.plan_files where id = :'roof'), 'what''s in the Trash stays as it was');

-- ===== Stored files: nobody signed in deletes one ==============================================
begin;
set local role authenticated;
select tdr.as_user(:'ann');
select tdr.check(tdr.changed(format('delete from storage.objects where name = %L', :'roof_path')) = 0, 'the owner can''t delete a stored file');
select tdr.as_user(:'ola');
select tdr.check(tdr.changed(format('delete from storage.objects where name = %L', :'roof_path')) = 0, 'nor can whoever stored it');
select tdr.as_user(:'cy');
select tdr.check(tdr.changed(format('delete from storage.objects where name like %L', :'co' || '/visit/%')) = 0, 'nor the crew their own photo');
select tdr.as_user(:'sal');
select tdr.check(tdr.changed(format('delete from storage.objects where name like %L', :'co' || '/%')) = 0, 'nor a sub');
commit;
select tdr.check((select count(*) from storage.objects where name in (:'roof_path', :'co' || '/visit/' || :'v1' || '/dd000000-0000-0000-0000-0000000000a1.jpg')) = 2, 'they''re all still there');

\o
\echo 'Stored files of everything else'
\o /dev/null

-- ===== Into the Trash ==========================================================================
-- What the team keeps elsewhere, each with its stored file (written as the server would).
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, size_bytes, caption, created_by) values
  (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/dd000000-0000-0000-0000-0000000000a1.jpg', 'before.jpg', 'image/jpeg', 1200, 'Before', :'cy'),
  (:'co', 'quote', :'q1', :'co' || '/quote/' || :'q1' || '/dd000000-0000-0000-0000-0000000000a2.jpg', 'ridge.jpg', 'image/jpeg', 900, null, :'ola');
select id as photo from public.attachments where file_name = 'before.jpg' \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path, file_name, content_type, size_bytes, carrier, expires_on, uploaded_via, uploaded_by)
  values (:'co', :'sub', 'liability', :'co' || '/subs/' || :'sub' || '/coi.pdf', 'coi.pdf', 'application/pdf', 4000, 'Acme Mutual', current_date + 200, 'sub', :'sal')
  returning id as coi \gset
insert into public.expenses (company_id, amount, user_id, job_id, vendor, receipt_path) values
  (:'co', 54.20, :'cy', :'j1', 'Supply House', :'co' || '/receipts/dd000000-0000-0000-0000-0000000000b1.jpg') returning id as expense \gset
insert into public.expenses (company_id, amount, user_id, job_id, receipt_path) values
  (:'co', 12.00, :'lou', :'j1', :'co' || '/receipts/dd000000-0000-0000-0000-0000000000b2.jpg') returning id as expense2 \gset
insert into public.expenses (company_id, amount, user_id) values (:'co', 5, :'lou') returning id as no_receipt \gset
insert into public.sop_pages (company_id, title, status, cover_path) values (:'co', 'Ladder safety', 'published', :'co' || '/kb/dd000000-0000-0000-0000-0000000000c1.jpg') returning id as guide \gset
insert into public.job_applicants (id, company_id, name, files) values ('dd000000-0000-0000-0000-0000000000d0', :'co', 'Pat Applicant', jsonb_build_array(
  jsonb_build_object('path', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d0/1.pdf', 'name', 'resume.pdf', 'type', 'application/pdf', 'size', 3000, 'field', 'resume'),
  jsonb_build_object('path', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d0/2.pdf', 'name', 'letter.pdf', 'type', 'application/pdf', 'size', 2000, 'field', 'letter')))
  returning id as applicant \gset
insert into public.job_applicants (id, company_id, name, files) values ('dd000000-0000-0000-0000-0000000000d1', :'co', 'Gone Applicant', jsonb_build_array(
  jsonb_build_object('path', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d1/1.pdf', 'name', 'cv.pdf', 'type', 'application/pdf', 'size', 1000)))
  returning id as applicant2 \gset
insert into public.equipment (company_id, name, kind, photo_path) values (:'co', 'Dump trailer', 'trailer', :'co' || '/equipment/dd000000-0000-0000-0000-0000000000e1.jpg') returning id as trailer \gset
insert into public.job_materials (company_id, job_id, name, quantity, unit, ticket, logged_by, photo_path)
  values (:'co', :'j1', 'Shingles', 26, 'sq', '4411', :'ann', :'co' || '/tickets/' || :'j1' || '/dd000000-0000-0000-0000-0000000000f1.jpg') returning id as material \gset
insert into public.measurements (company_id, property_id, geojson, snapshot_path)
  values (:'co', :'p1', '{"type": "FeatureCollection", "features": []}', :'co' || '/measurements/dd000000-0000-0000-0000-0000000000a9.jpg') returning id as drawing \gset
begin;
set local role authenticated;
select tdr.as_user(:'ann');
select public.chat_set_enabled(:'co', true);
commit;
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
insert into public.chat_messages (company_id, channel_id, author_id, body, attachments) values (:'co', :'general', :'ann', 'The ridge',
  jsonb_build_array(jsonb_build_object('path', :'co' || '/chat/' || :'general' || '/dd000000-0000-0000-0000-0000000000a8.jpg', 'name', 'ridge.jpg', 'type', 'image/jpeg', 'size', 500)))
  returning id as message \gset
select count(*) as subs_notices from public.notifications where kind = 'subs' and company_id = :'co' \gset

-- Each taken out, or its file replaced, by the people who can.
begin;
set local role authenticated;
select tdr.as_user(:'cy');
select tdr.check(tdr.changed(format('delete from public.attachments where id = %L', :'photo')) = 1, 'the crew take back a photo they added to a visit');
select tdr.as_user(:'ola');
delete from public.attachments where owner_type = 'quote';
select tdr.as_user(:'ann');
delete from public.sub_documents where id = :'coi';
delete from public.expenses where id in (:'expense', :'no_receipt');
update public.expenses set receipt_path = :'co' || '/receipts/dd000000-0000-0000-0000-0000000000b3.jpg' where id = :'expense2';
update public.sop_pages set cover_path = :'co' || '/kb/dd000000-0000-0000-0000-0000000000c2.jpg' where id = :'guide';
update public.job_applicants set files = files - 1 where id = :'applicant';
delete from public.job_applicants where id = :'applicant2';
update public.equipment set photo_path = :'co' || '/equipment/dd000000-0000-0000-0000-0000000000e2.jpg' where id = :'trailer';
delete from public.job_materials where id = :'material';
update public.measurements set snapshot_path = :'co' || '/measurements/dd000000-0000-0000-0000-0000000000aa.jpg' where id = :'drawing';
update public.chat_messages set deleted_at = now() where id = :'message';
commit;

select tdr.check((select source = 'visit_photo' and label = 'Visit photo · Job #' || :'j1_no' and file_name = 'before.jpg' and content_type = 'image/jpeg' and size_bytes = 1200
    and source_id = :'v1' and deleted_by = :'cy' and restore ->> 'id' = :'photo'
  from public.trashed_files where path = :'co' || '/visit/' || :'v1' || '/dd000000-0000-0000-0000-0000000000a1.jpg'), 'a visit photo taken out goes in the Trash, ready to go back');
select tdr.check((select source = 'quote_photo' and label = 'Quote photo · Quote #' || :'q1_no' and source_id = :'q1' and deleted_by = :'ola'
  from public.trashed_files where path like '%/quote/%'), 'so does a quote photo');
select tdr.check((select source = 'sub_document' and label = 'Paperwork · Sal''s Siding' and file_name = 'coi.pdf' and source_id = :'sub' and restore ->> 'uploaded_via' = 'sub'
  from public.trashed_files where path like '%/subs/%'), 'and a sub''s paperwork, as it was');
select tdr.check((select source = 'receipt' and label = 'Receipt · Supply House · Job #' || :'j1_no' and file_name = 'Receipt from Supply House.jpg' and source_id = :'expense'
  from public.trashed_files where path like '%b1.jpg'), 'an expense''s receipt, with the expense');
select tdr.check((select source = 'receipt' and source_id = :'expense2' from public.trashed_files where path like '%b2.jpg')
  and not exists (select 1 from public.trashed_files where path like '%b3.jpg'), 'and one replaced by another, not the new one');
select tdr.check((select source = 'kb_cover' and label = 'Guide cover · Ladder safety' and file_name = 'Ladder safety cover.jpg' from public.trashed_files where path like '%c1.jpg'),
  'a guide''s old cover');
select tdr.check((select source = 'applicant_file' and label = 'Applicant · Pat Applicant' and file_name = 'letter.pdf' and size_bytes = 2000
    and restore -> 'file' ->> 'field' = 'letter' and restore ->> 'applicant_id' = :'applicant' from public.trashed_files where path like '%d0/2.pdf')
  and not exists (select 1 from public.trashed_files where path like '%d0/1.pdf'), 'a file taken off an applicant, and not the one kept');
select tdr.check((select count(*) from public.trashed_files where path like '%d1/1.pdf' and source = 'applicant_file') = 1, 'an applicant''s files with the applicant');
select tdr.check((select source = 'equipment_photo' and file_name = 'Dump trailer.jpg' and label = 'Equipment photo · Dump trailer' from public.trashed_files where path like '%e1.jpg'),
  'a machine''s old photo');
select tdr.check((select source = 'ticket_photo' and file_name = 'Ticket 4411.jpg' and label = 'Ticket photo · Job #' || :'j1_no' from public.trashed_files where path like '%f1.jpg'),
  'a plant ticket''s photo');
select tdr.check((select source = 'measurement_snapshot' from public.trashed_files where path like '%a9.jpg'), 'a measurement''s old picture');
select tdr.check((select source = 'chat_file' and source_id = :'message' from public.trashed_files where path like '%a8.jpg'), 'and a deleted chat message''s photo');
select tdr.check((select count(*) from public.trashed_files where company_id = :'co') = 12, 'and nothing else: an expense without a receipt has nothing to keep');
select tdr.check((select count(*) from public.notifications where kind = 'subs' and company_id = :'co') = :subs_notices, '(no notices about any of it)');

-- The same file twice, or none, keeps one row; another company's or a made-up path, none.
insert into public.expenses (company_id, amount, receipt_path) values (:'co', 1, :'co' || '/receipts/dd000000-0000-0000-0000-0000000000b1.jpg'),
  (:'co', 1, ''), (:'co', 1, :'other' || '/receipts/x.jpg'), (:'co', 1, :'co' || '/receipts/../plans/x.pdf');
delete from public.expenses where amount = 1;
select tdr.check((select count(*) from public.trashed_files where company_id = :'co') = 12, 'a file already there, an empty path or one that isn''t this company''s adds nothing');

begin;
set local role authenticated;
select tdr.as_user(:'ann');
select tdr.check(tdr.error_of('select count(*) from public.trashed_files') like '42501:%', 'nobody signed in reads the table, not even the owner');
select tdr.check(tdr.error_of(format('delete from public.trashed_files where company_id = %L', :'co')) like '42501:%', 'or changes it');
commit;

-- ===== Who sees what in the Trash ===============================================================
begin;
set local role authenticated;
select tdr.as_user(:'ann');
select tdr.check((select count(*) from public.drive_trash(:'co') where kind = 'other') = 10
  and not exists (select 1 from public.drive_trash(:'co') where path like '%/measurements/%' or path like '%/chat/%'),
  'the owner sees the stored files of everything else, but not a measurement''s picture or a chat photo');
select tdr.check((select name = 'before.jpg' and detail = 'Visit photo · Job #' || :'j1_no' and versions = 1 from public.drive_trash(:'co') where path like '%a1.jpg'),
  'each by its name and where it was');
select tdr.as_user(:'dot');
select tdr.check((select array_agg(distinct split_part(path, '/', 2) order by split_part(path, '/', 2)) from public.drive_trash(:'co') where kind = 'other')
  = '{equipment,kb,quote,tickets,visit}', 'office staff without the job costs, subs or hiring areas don''t see receipts, paperwork or résumés');
select tdr.as_user(:'cy');
select tdr.check((select array_agg(name) from public.drive_trash(:'co')) = '{before.jpg}', 'the crew see only the photo they took out');
select tdr.as_user(:'lou');
select tdr.check(not exists (select 1 from public.drive_trash(:'co') where kind = 'other'), 'a crew lead sees none of it (their receipt was replaced by the office)');
select tdr.as_user(:'sal');
select tdr.check(not exists (select 1 from public.drive_trash(:'co')), 'a sub sees nothing in the Trash');
select tdr.expect_error(format('select public.drive_restore(%L, (select id from public.drive_trash(%L) limit 1))', 'other', :'co'), 'or restores anything');
commit;
select id as photo_trash from public.trashed_files where path like '%a1.jpg' \gset
select id as quote_trash from public.trashed_files where path like '%/quote/%' \gset
select id as coi_trash from public.trashed_files where path like '%/subs/%' \gset
select id as receipt_trash from public.trashed_files where path like '%b1.jpg' \gset
select id as letter_trash from public.trashed_files where path like '%d0/2.pdf' \gset
select id as cv_trash from public.trashed_files where path like '%d1/1.pdf' \gset
select id as drawing_trash from public.trashed_files where path like '%a9.jpg' \gset

-- ===== Back where they were ====================================================================
begin;
set local role authenticated;
select tdr.as_user(:'dot');
select tdr.expect_error(format('select public.drive_restore(%L, %L)', 'other', :'coi_trash'), 'office staff without the subs area can''t restore paperwork');
select tdr.as_user(:'cy');
select tdr.expect_error(format('select public.drive_restore(%L, %L)', 'other', :'quote_trash'), 'the crew can''t restore someone else''s photo');
select tdr.check(public.drive_restore('other', :'photo_trash') = 'restored', 'but restore the photo they took out');
select tdr.check((select count(*) from public.attachments where id = :'photo' and owner_id = :'v1' and caption = 'Before' and created_by = :'cy') = 1,
  'back on its visit, as it was');
select tdr.as_user(:'ann');
select tdr.check(public.drive_restore('other', :'coi_trash') = 'restored', 'the owner restores the sub''s paperwork');
select tdr.check((select uploaded_via = 'sub' and uploaded_by = :'sal' and verified_at is null and superseded_at is null and carrier = 'Acme Mutual'
  from public.sub_documents where id = :'coi'), 'back with the sub as it was: sent by the sub, still waiting to be checked');
select tdr.check(public.drive_restore('other', :'letter_trash') = 'restored', 'a letter goes back on its applicant');
select tdr.check((select jsonb_array_length(files) = 2 and files -> 1 ->> 'name' = 'letter.pdf' from public.job_applicants where id = :'applicant'), 'with the rest of their files');
select tdr.check(tdr.error_of(format('select public.drive_restore(%L, %L)', 'other', :'cv_trash'))
  = '22023: This file can''t go back where it was, because that was deleted. Download it from the Trash instead.',
  'a résumé whose applicant is gone has nowhere to go back to, and never goes into Drive: it''s downloaded instead');
select tdr.check(tdr.error_of(format('select public.drive_restore(%L, %L)', 'other', :'receipt_trash'))
  = '22023: This file can''t go back where it was, because that was deleted. Download it from the Trash instead.', 'nor does a receipt whose expense is gone');
select tdr.expect_error(format('select public.drive_restore(%L, %L)', 'other', :'drawing_trash'), 'a measurement''s picture isn''t restored');
delete from public.quotes where id = :'q1';
select tdr.check(public.drive_restore('other', :'quote_trash') = 'needs_copy', 'a photo whose quote is gone: the office copies it into Drive (the server does)');
commit;
select tdr.check(not exists (select 1 from public.trashed_files where id in (:'photo_trash', :'coi_trash', :'letter_trash'))
  and (select count(*) from public.trashed_files where id in (:'cv_trash', :'receipt_trash', :'quote_trash')) = 3, 'what''s back is out of the Trash; the rest stays');
select tdr.check((select count(*) from public.notifications where kind = 'subs' and company_id = :'co') = :subs_notices, 'paperwork put back tells no one it was sent');

\o
\echo 'What Restore does'
\o /dev/null

-- ===== What Restore does, for each person =======================================================
begin;
set local role authenticated;
select tdr.as_user(:'ann');
select tdr.check((select string_agg(split_part(path, '/', 2) || ':' || restore, ',' order by path) from public.drive_trash(:'co') where kind = 'other')
  = 'applicants:download,equipment:drive,kb:drive,quote:drive,receipts:download,receipts:download,tickets:drive',
  'the owner: photos, covers and tickets whose place is gone are copied into Drive; résumés and receipts are downloaded instead');
select tdr.check(exists (select 1 from public.drive_trash(:'co') where kind <> 'other') and not exists (select 1 from public.drive_trash(:'co') where kind <> 'other' and restore <> 'back'),
  'Drive''s own files, versions and folders go back where they were');
select tdr.as_user(:'dot');
select tdr.check((select string_agg(split_part(path, '/', 2) || ':' || restore, ',' order by path) from public.drive_trash(:'co') where kind = 'other')
  = 'equipment:drive,kb:drive,quote:drive,tickets:drive', 'office staff without those areas: only what they see, into Drive');
commit;

-- A photo the crew took out, then its visit deleted: the office copies it into Drive; the crew
-- member who took it out downloads it.
insert into public.visits (company_id, job_id, property_id, title, starts_at, ends_at)
  values (:'co', :'j1', :'p1', 'Cleanup', now() + interval '2 days', now() + interval '2 days 2 hours') returning id as v2 \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, created_by)
  values (:'co', 'visit', :'v2', :'co' || '/visit/' || :'v2' || '/dd000000-0000-0000-0000-0000000000a5.jpg', 'gutter.jpg', :'cy') returning id as gutter_photo \gset
begin;
set local role authenticated;
select tdr.as_user(:'cy');
delete from public.attachments where id = :'gutter_photo';
commit;
delete from public.visits where id = :'v2';
select id as gutter_trash from public.trashed_files where path like '%a5.jpg' \gset
begin;
set local role authenticated;
select tdr.as_user(:'cy');
select tdr.check((select restore = 'download' from public.drive_trash(:'co') where id = :'gutter_trash'), 'the crew member who took out a photo whose visit is gone downloads it');
select tdr.check(tdr.error_of(format('select public.drive_restore(%L, %L)', 'other', :'gutter_trash'))
  = '22023: This file can''t go back where it was, because that was deleted. Download it from the Trash instead.', 'and Restore says so (only the office copies into Drive)');
select tdr.as_user(:'ola');
select tdr.check((select restore = 'drive' from public.drive_trash(:'co') where id = :'gutter_trash'), 'the office copies it into Drive');
select tdr.check(public.drive_restore('other', :'gutter_trash') = 'needs_copy', 'and Restore says so');
rollback;

-- A receipt taken off its expense goes back on it; one whose expense has another receipt now is
-- downloaded instead.
begin;
set local role authenticated;
select tdr.as_user(:'ann');
update public.expenses set receipt_path = null where id = :'expense2';
select id as b3_trash from public.drive_trash(:'co') where path like '%b3.jpg' \gset
select id as b2_trash from public.drive_trash(:'co') where path like '%b2.jpg' \gset
select tdr.check((select restore = 'back' from public.drive_trash(:'co') where id = :'b3_trash'), 'a receipt taken off an expense goes back on it');
select tdr.check(public.drive_restore('other', :'b3_trash') = 'restored', 'and does');
select tdr.check((select receipt_path like '%b3.jpg' from public.expenses where id = :'expense2'), '(it''s the expense''s receipt again)');
select tdr.check(tdr.error_of(format('select public.drive_restore(%L, %L)', 'other', :'b2_trash')) = '22023: Its expense has another receipt now. Download this one from the Trash instead.',
  'one whose expense has another receipt now is downloaded instead');
commit;

-- Someone who took out a receipt but can't open receipts (no job costs, and not theirs) can do
-- nothing with it; their own they download.
insert into public.expenses (company_id, amount, user_id, receipt_path) values
  (:'co', 9, :'cy', :'co' || '/receipts/dd000000-0000-0000-0000-0000000000b5.jpg'), (:'co', 8, :'dot', :'co' || '/receipts/dd000000-0000-0000-0000-0000000000b6.jpg');
insert into storage.objects (bucket_id, name, owner) values
  ('files', :'co' || '/receipts/dd000000-0000-0000-0000-0000000000b5.jpg', :'cy'), ('files', :'co' || '/receipts/dd000000-0000-0000-0000-0000000000b6.jpg', :'dot');
begin;
select tdr.as_user(:'dot');
delete from public.expenses where company_id = :'co' and amount in (8, 9);
commit;
select id as b5_trash from public.trashed_files where path like '%b5.jpg' \gset
begin;
set local role authenticated;
select tdr.as_user(:'dot');
select tdr.check((select string_agg(right(path, 6) || ':' || restore, ',' order by path) from public.drive_trash(:'co') where path like '%/receipts/%') = 'b5.jpg:none,b6.jpg:download',
  'a receipt they took out: theirs to download, someone else''s to leave');
select tdr.check(tdr.error_of(format('select public.drive_restore(%L, %L)', 'other', :'b5_trash'))
  = '22023: This file can''t go back where it was. Ask someone who sees job costs to download it from the Trash.', 'and Restore says who can');
rollback;

-- ===== Paperwork with its sub, ticket photos with their job ======================================
insert into public.subcontractors (company_id, name) values (:'co', 'Smith Roofing LLC') returning id as smith \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path, file_name, content_type, carrier, expires_on, uploaded_via, uploaded_by)
  values (:'co', :'smith', 'liability', :'co' || '/subs/' || :'smith' || '/coi.pdf', 'coi.pdf', 'application/pdf', 'Acme Mutual', current_date + 100, 'office', :'ann');
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'c1', :'p1', 'Porch roof') returning id as j3 \gset
select number as j3_no from public.jobs where id = :'j3' \gset
insert into public.job_materials (company_id, job_id, name, quantity, unit, ticket, logged_by, photo_path)
  values (:'co', :'j3', 'Shingles', 4, 'sq', '5120', :'ann', :'co' || '/tickets/' || :'j3' || '/dd000000-0000-0000-0000-0000000000f3.jpg');
begin;
select tdr.as_user(:'ann');
delete from public.subcontractors where id = :'smith';
delete from public.jobs where id = :'j3';
commit;
select tdr.check((select label = 'Paperwork · Smith Roofing LLC (deleted)' and source_id = :'smith' from public.trashed_files where path like '%/subs/' || :'smith' || '/%'),
  'paperwork that went with its sub still says whose it was');
select tdr.check((select label = 'Ticket photo · Job #' || :'j3_no' || ' (deleted)' from public.trashed_files where path like '%f3.jpg'),
  'and a ticket photo that went with its job, which job');

\o
\echo 'A row can''t hand over a file that isn''t its own'
\o /dev/null

-- ===== Nobody gets someone else's file deleted ===================================================
-- A plan on the job the crew can see; Ola's photo on their visit; a plant ticket Ann logged; Ann's
-- photo in the team chat.
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'Truss layout', tdr.path(:'co'), 'truss.pdf') returning id as truss \gset
commit;
select path as truss_path from public.plan_files where id = :'truss' \gset
select :'co' || '/visit/' || :'v1' || '/dd000000-0000-0000-0000-0000000000a6.jpg' as ola_photo \gset
select :'co' || '/tickets/' || :'j1' || '/dd000000-0000-0000-0000-0000000000f2.jpg' as ann_ticket \gset
select :'co' || '/chat/' || :'general' || '/dd000000-0000-0000-0000-0000000000a7.jpg' as ann_chat \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, created_by) values (:'co', 'visit', :'v1', :'ola_photo', 'flashing.jpg', :'ola');
insert into public.job_materials (company_id, job_id, name, quantity, unit, logged_by, photo_path) values (:'co', :'j1', 'Drip edge', 10, 'pc', :'ann', :'ann_ticket');
insert into public.chat_messages (company_id, channel_id, author_id, body, attachments)
  values (:'co', :'general', :'ann', 'Flashing', jsonb_build_array(jsonb_build_object('path', :'ann_chat', 'name', 'flashing.jpg', 'type', 'image/jpeg', 'size', 400)));

begin;
set local role authenticated;
select tdr.as_user(:'cy');
select tdr.check((select path from public.plan_files where id = :'truss') = :'truss_path', 'the crew can read where a plan on their job is stored');
select tdr.check(tdr.error_of(format('insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (%L, %L, %L, %L, %L)', :'co', 'visit', :'v1', :'truss_path', 'x.pdf'))
  = '22023: That file isn''t stored with what it''s on. Upload it again.', 'but a photo on their visit can''t name it');
select tdr.expect_error(format('insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (%L, %L, %L, %L, %L)', :'co', 'job', :'j1', :'truss_path', 'x.pdf'),
  'nor can a file on their job');
select tdr.check(tdr.error_of(format('insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (%L, %L, %L, %L, %L)',
    :'co', 'avatars', :'ann', :'co' || '/avatars/' || :'ann' || '/x.jpg', 'x.jpg'))
  = '22023: A file goes on a visit, a quote, a client, a property, a request, a job or an invoice.', 'nor a "file" on something that isn''t a record');
select tdr.check(tdr.error_of(format('insert into public.job_materials (company_id, job_id, name, quantity, logged_by, photo_path) values (%L, %L, %L, 1, %L, %L)', :'co', :'j1', 'Nails', :'cy', :'truss_path'))
  = '22023: That ticket photo isn''t stored with its job. Add the photo again.', 'nor a plant ticket on their job');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name)
  values (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/dd000000-0000-0000-0000-0000000000a4.jpg', 'mine.jpg') returning id as mine \gset
select tdr.check((select created_by = :'cy' from public.attachments where id = :'mine'), '(a photo of their own goes on their visit as always)');
select tdr.expect_error(format('update public.attachments set path = %L where id = %L', :'truss_path', :'mine'), 'and can''t be changed to name the plan');
select tdr.expect_error(format('update public.attachments set path = %L where id = %L', :'co' || '/visit/' || :'v1' || '/../../plans/x.pdf', :'mine'), 'or to climb out of its folder');
-- Copies of someone else's photo on the same visit, ticket on the same job and photo in the same
-- channel are where those are kept, so they're allowed: taking them out must hand over nothing.
insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (:'co', 'visit', :'v1', :'ola_photo', 'copy.jpg');
insert into public.job_materials (company_id, job_id, name, quantity, logged_by, photo_path) values (:'co', :'j1', 'Decoy copy', 1, :'cy', :'ann_ticket');
insert into public.chat_messages (company_id, channel_id, author_id, body, attachments)
  values (:'co', :'general', :'cy', 'Same', jsonb_build_array(jsonb_build_object('path', :'ann_chat', 'name', 'x.jpg', 'type', 'image/jpeg', 'size', 1))) returning id as copy_msg \gset
commit;
-- Rows naming the plan from before these rules (written past the guard).
alter table public.attachments disable trigger stored_path_guard;
alter table public.job_materials disable trigger stored_path_guard;
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, created_by) values
  (:'co', 'visit', :'v1', :'truss_path', 'decoy.pdf', :'cy'), (:'co', 'job', :'j1', :'truss_path', 'decoy 2.pdf', :'cy');
insert into public.job_materials (company_id, job_id, name, quantity, logged_by, photo_path) values (:'co', :'j1', 'Decoy', 1, :'cy', :'truss_path');
alter table public.attachments enable trigger stored_path_guard;
alter table public.job_materials enable trigger stored_path_guard;

begin;
set local role authenticated;
select tdr.as_user(:'cy');
select tdr.check(tdr.changed(format('delete from public.attachments where created_by = %L and file_name in (%L, %L, %L)', :'cy', 'decoy.pdf', 'decoy 2.pdf', 'copy.jpg')) = 3,
  'the crew take out the rows they made');
select tdr.check(tdr.changed(format('delete from public.job_materials where logged_by = %L and name like %L', :'cy', 'Decoy%')) = 2, 'and the materials they logged');
update public.chat_messages set deleted_at = now() where id = :'copy_msg';
commit;
select tdr.check(not exists (select 1 from public.trashed_files where path in (:'truss_path', :'ola_photo', :'ann_ticket', :'ann_chat')),
  'none of the files those named went in the Trash: not the plan, nor the photos and the ticket someone else took');
select tdr.check((select count(*) from public.plan_files where id = :'truss' and deleted_at is null) = 1, 'the plan is as it was');

-- A row in the Trash naming a file in use (as one could before these rules): the server deletes
-- the row and never the file.
insert into public.trashed_files (company_id, path, source, label, deleted_at) values (:'co', :'truss_path', 'visit_photo', 'Visit photo', now() - interval '40 days')
  returning id as decoy_trash \gset
begin;
set local role authenticated;
select tdr.as_user(:'ola');
select tdr.check(public.drive_restore('other', :'decoy_trash') = 'restored', 'restoring it just takes it out of the Trash: the file is in use');
rollback;
set role service_role;
select tdr.check(public.trash_copied_to_drive(:'co', :'decoy_trash') is null, 'copied into Drive, the original is kept: something uses it');
reset role;
insert into public.trashed_files (company_id, path, source, label, deleted_at) values (:'co', :'truss_path', 'visit_photo', 'Visit photo', now() - interval '40 days')
  returning id as decoy_trash \gset
set role service_role;
select coalesce(string_agg(source || ':' || deleted || ':' || tdr.files(paths), ','), 'nothing') as purged from public.trash_purge(now(), 1000) \gset
reset role;
select tdr.check(:'purged' = 'trashed_files:1:kept', 'the purge deletes the row and keeps the file');
insert into public.trashed_files (company_id, path, source, label) values (:'co', :'truss_path', 'visit_photo', 'Visit photo') returning id as decoy_trash \gset
begin;
set local role authenticated;
select tdr.as_user(:'ann');
select tdr.check((select string_agg(kind || ':' || tdr.files(paths), ',') from public.trash_delete_forever(:'co', jsonb_build_array(jsonb_build_object('kind', 'other', 'id', :'decoy_trash')))) = 'other:kept',
  'and so does the owner''s Delete forever');
commit;
select tdr.check(not exists (select 1 from public.trashed_files where path = :'truss_path') and (select count(*) from public.plan_files where id = :'truss') = 1,
  'the plan''s file is never handed over to be deleted');

\o
\echo 'A file put back in use some other way'
\o /dev/null

-- ===== A file back in use (an older copy of the page saved it again) ==============================
\set letter '{"path": "PATH", "name": "letter.pdf", "type": "application/pdf", "size": 2000, "field": "letter"}'
select replace(:'letter', 'PATH', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d0/2.pdf') as letter \gset
begin;
set local role authenticated;
select tdr.as_user(:'ann');
update public.job_applicants set files = files - 1 where id = :'applicant';
select id as letter_trash from public.drive_trash(:'co') where path like '%d0/2.pdf' \gset
update public.job_applicants set files = files || jsonb_build_array(:'letter'::jsonb) where id = :'applicant';
select tdr.check((select restore = 'back' from public.drive_trash(:'co') where id = :'letter_trash'), 'a file back in use some other way still shows in the Trash, to go back');
commit;
update public.trashed_files set deleted_at = now() - interval '40 days' where id = :'letter_trash';
set role service_role;
select coalesce(string_agg(source || ':' || deleted || ':' || tdr.files(paths), ','), 'nothing') as purged from public.trash_purge(now(), 1000) \gset
reset role;
select tdr.check(:'purged' = 'trashed_files:1:kept' and not exists (select 1 from public.trashed_files where id = :'letter_trash'),
  'its 30 days up, the purge takes it out of the Trash and keeps the file the applicant lists');
select tdr.check((select files @> jsonb_build_array(jsonb_build_object('path', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d0/2.pdf')) from public.job_applicants where id = :'applicant'),
  '(still listed)');

-- Taken off, back in use, and taken off again: its 30 days start again.
begin;
set local role authenticated;
select tdr.as_user(:'ann');
update public.job_applicants set files = files - 1 where id = :'applicant';
update public.job_applicants set files = files || jsonb_build_array(:'letter'::jsonb) where id = :'applicant';
commit;
select id as letter_trash from public.trashed_files where path like '%d0/2.pdf' \gset
update public.trashed_files set deleted_at = now() - interval '40 days' where id = :'letter_trash';
begin;
set local role authenticated;
select tdr.as_user(:'ann');
update public.job_applicants set files = files - 1 where id = :'applicant';
commit;
select tdr.check((select id = :'letter_trash' and deleted_at > now() - interval '1 hour' and source_id = :'applicant' from public.trashed_files where path like '%d0/2.pdf'),
  'taken off again, it''s in the Trash for 30 days from then');
begin;
set local role authenticated;
select tdr.as_user(:'ann');
update public.job_applicants set files = files || jsonb_build_array(:'letter'::jsonb) where id = :'applicant';
select tdr.check(public.drive_restore('other', :'letter_trash') = 'restored', 'restoring one already back in use takes it out of the Trash');
select tdr.check((select jsonb_array_length(files) = 2 from public.job_applicants where id = :'applicant'), 'without listing it twice');
commit;
select tdr.check(not exists (select 1 from public.trashed_files where path like '%d0/2.pdf'), '(it''s out of the Trash)');

\o
\echo 'A restore and a purge at the same moment'
\o /dev/null

-- ===== Whichever comes first wins, whole ========================================================
-- (dblink, for a second and third sign-in at once; another test may have it already.)
create schema tdr_link;
set client_min_messages = warning;
create extension if not exists dblink schema tdr_link;
reset client_min_messages;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'Ridge detail', tdr.path(:'co'), 'ridge.pdf') returning id as race_a \gset
select public.drive_trash_file(:'race_a');
commit;
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'Valley detail', tdr.path(:'co'), 'valley.pdf') returning id as race_b \gset
select public.drive_trash_file(:'race_b');
commit;
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, created_by)
  values (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/dd000000-0000-0000-0000-0000000000a3.jpg', 'valley.jpg', :'ola') returning id as race_photo \gset
begin;
select tdr.as_user(:'ola');
delete from public.attachments where id = :'race_photo';
commit;
select path as race_a_path from public.plan_files where id = :'race_a' \gset
select id as race_photo_trash, path as race_photo_path from public.trashed_files where path like '%a3.jpg' \gset
begin;
select set_config('crewtavo.trash', 'on', true);
update public.plan_files set deleted_at = deleted_at - interval '40 days' where id = :'race_a';
commit;
update public.trashed_files set deleted_at = deleted_at - interval '40 days' where id = :'race_photo_trash';
select :"dbl".dblink_connect('restorer', 'dbname=' || current_database());
select :"dbl".dblink_connect('purger', 'dbname=' || current_database());
select * from :"dbl".dblink('restorer', format('select set_config(%L, %L, false)', 'request.jwt.claims', json_build_object('sub', :'ola', 'role', 'authenticated')::text)) as r(v text);

-- Restores first: the purge, started meanwhile, waits for them and then leaves what came back.
select :"dbl".dblink_exec('restorer', 'begin');
select * from :"dbl".dblink('restorer', format('select public.drive_restore(%L, %L)', 'file', :'race_a')) as r(v text);
select * from :"dbl".dblink('restorer', format('select public.drive_restore(%L, %L)', 'other', :'race_photo_trash')) as r(v text);
select :"dbl".dblink_send_query('purger', format('select count(*) from public.trash_purge(now(), 1000) t, unnest(t.paths) x(path) where x.path in (%L, %L)', :'race_a_path', :'race_photo_path'));
do $$ begin
  for i in 1..100 loop
    exit when exists (select 1 from pg_stat_activity where wait_event_type = 'Lock');
    perform pg_sleep(0.05);
  end loop;
end $$;
select tdr.check(:"dbl".dblink_is_busy('purger') = 1, '(the purge waits for the restores)');
select :"dbl".dblink_exec('restorer', 'commit');
select n as raced from :"dbl".dblink_get_result('purger') as r(n bigint) \gset
select count(*) from :"dbl".dblink_get_result('purger') as r(n bigint);
select tdr.check(:raced = 0, 'a purge that waited for a restore hands over none of its files');
select tdr.check((select deleted_at is null from public.plan_files where id = :'race_a') and (select count(*) from public.attachments where path = :'race_photo_path') = 1,
  'what came back stays: the file, and the photo on its visit');

-- The purge first: a restore started meanwhile waits for it, then finds nothing to restore.
begin;
select set_config('crewtavo.trash', 'on', true);
update public.plan_files set deleted_at = deleted_at - interval '40 days' where id = :'race_b';
commit;
select :"dbl".dblink_exec('purger', 'begin');
select * from :"dbl".dblink('purger', 'select count(*) from public.trash_purge(now(), 1000)') as r(n bigint);
select :"dbl".dblink_send_query('restorer', format('select public.drive_restore(%L, %L)', 'file', :'race_b'));
do $$ begin
  for i in 1..100 loop
    exit when exists (select 1 from pg_stat_activity where wait_event_type = 'Lock');
    perform pg_sleep(0.05);
  end loop;
end $$;
select tdr.check(:"dbl".dblink_is_busy('restorer') = 1, '(the restore waits for the purge)');
select :"dbl".dblink_exec('purger', 'commit');
set client_min_messages = warning;
select count(*) from :"dbl".dblink_get_result('restorer', false) as r(result text);
reset client_min_messages;
select tdr.check(:"dbl".dblink_error_message('restorer') like '%That file isn''t in the Trash.%', 'a restore that waited for the purge finds it gone, and says so');
select tdr.check(not exists (select 1 from public.plan_files where id = :'race_b'), '(it went for good)');
select :"dbl".dblink_disconnect('restorer');
select :"dbl".dblink_disconnect('purger');
set client_min_messages = warning;
drop schema tdr_link cascade;
reset client_min_messages;
-- (Out of the way of the lists below.)
delete from public.plan_files where id in (:'truss', :'race_a');

\o
\echo 'Drive''s lists'
\o /dev/null

-- ===== Lists and search ========================================================================
begin;
set local role authenticated;
select tdr.as_user(:'ola');
select tdr.check((select array_agg(title order by title) from public.drive_list(:'co', 'folder')) = '{Imported,"Price sheet","W-9 form"}',
  'Company files: the current version of each file in it, by name');
select tdr.check((select versions = 2 and folder_name = 'Company files' and created_by_name = 'Ola Office' from public.drive_list(:'co', 'folder') where title = 'W-9 form'),
  'with how many versions, its folder and who added it');
select tdr.check((select array_agg(title) from public.drive_list(:'co', 'folder', :'prices')) = '{"Spec book"}', 'another folder');
select tdr.check((select array_agg(title order by title) from public.drive_list(:'co', 'client', :'c1')) = '{"Field sketch","Price sheet","Site plan","Site plan (Rev B)"}',
  'a client''s files, on their properties and jobs');
select tdr.check((select client_name = 'Ann Client' and job_number = :'j1_no' and job_title = 'New roof' and property_label = '14 Oak St' and revision = 'Rev C'
  from public.drive_list(:'co', 'client', :'c1') where id = :'site3'), 'each with where it is');
select tdr.check((select array_agg(title order by title) from public.drive_list(:'co', 'recent', null, null, 2)) = '{"Site plan","Site plan (Rev B)"}', 'the newest first, as many as asked');
select tdr.check((select array_agg(id) from public.drive_list(:'co', 'search', null, 'rev c')) = array[:'site3']::uuid[], 'search finds a file by its revision');
select tdr.check((select count(*) from public.drive_list(:'co', 'search', null, 'ann client')) = 4, 'by its client');
select tdr.check((select count(*) from public.drive_list(:'co', 'search', null, '#' || :'j1_no')) = 4, 'by its job''s number');
select tdr.check((select count(*) from public.drive_list(:'co', 'search', null, '%_')) = 0, 'and takes % and _ literally');
select tdr.check(not exists (select 1 from public.drive_list(:'co', 'search', null, 'roof plan')), 'not what''s in the Trash');
select tdr.expect_error(format('select * from public.drive_list(%L, %L)', :'co', 'everything'), 'a list it doesn''t know is refused');
select tdr.check((select row(client_name, files)::text from public.drive_clients(:'co')) = '("Ann Client",4)', 'clients with files, and how many');
select tdr.check(not exists (select 1 from public.drive_clients(:'co', 'zzz')), 'by name');
select tdr.check((select array_agg(id order by id) from public.drive_versions(:'site')) = (select array_agg(x order by x) from unnest(array[:'site3', :'site']::uuid[]) x),
  'a file''s versions (not one put back as a file of its own)');
select tdr.check((select subtitle = 'Job #' || :'j1_no' || ' · Ann Client' and client_id = :'c1' from public.global_search(:'co', 'site plan', 20) where kind = 'file' and id = :'site3'),
  'search everything finds files, saying where they are');
select tdr.check((select subtitle = 'Company files' from public.global_search(:'co', 'imported', 20) where kind = 'file'), 'a company file is in Company files');
select tdr.check(not exists (select 1 from public.global_search(:'co', 'roof plan', 20) where kind = 'file'), 'and not files in the Trash');
select tdr.as_user(:'lou');
select tdr.check((select array_agg(id) from public.drive_versions(:'site')) is null and (select array_agg(id) from public.drive_versions(:'site3')) = array[:'site3']::uuid[],
  'a crew lead sees only the current version');
select tdr.check(not exists (select 1 from public.drive_list(:'co', 'folder')), 'and no company folders');
select tdr.as_user(:'cy');
select tdr.check((select array_agg(title order by title) from public.drive_list(:'co', 'recent')) = '{"Field sketch","Price sheet","Site plan","Site plan (Rev B)"}',
  'the crew see only the files on their work marked for them');
select tdr.as_user(:'sal');
select tdr.check(not exists (select 1 from public.drive_list(:'co', 'recent')) and not exists (select 1 from public.drive_clients(:'co'))
  and not exists (select 1 from public.drive_versions(:'site3')) and not exists (select 1 from public.global_search(:'co', 'site')),
  'a sub gets nothing from Drive''s lists or search');
select tdr.as_user(:'oz');
select tdr.check(not exists (select 1 from public.drive_list(:'co', 'recent')) and not exists (select 1 from public.drive_trash(:'co')), 'nor another business');
commit;

\o
\echo 'Deleting for good'
\o /dev/null

-- ===== Deleting for good =========================================================================
-- A single version, a whole file and a folder with what's in it; then the files of everything else.
-- Two files moved there at the same moment (their client deleted) are two items.
begin;
set local role authenticated;
select tdr.as_user(:'ola');
select public.drive_trash_version(:'site3');
select public.drive_trash_folder(:'prices');
insert into public.clients (company_id, display_name) values (:'co', 'Cal Closed') returning id as c3 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c3', '3 Ash St') returning id as p3 \gset
insert into public.plan_files (company_id, property_id, title, path, file_name) values (:'co', :'p3', 'Survey', tdr.path(:'co'), 'survey.pdf') returning id as survey \gset
insert into public.plan_files (company_id, property_id, title, path, file_name) values (:'co', :'p3', 'Permit', tdr.path(:'co'), 'permit.pdf') returning id as permit \gset
delete from public.clients where id = :'c3';
select tdr.check((select count(*) from public.drive_trash(:'co') where id in (:'survey', :'permit') and kind = 'file') = 2, 'two files whose client was deleted are two items in the Trash');
select tdr.check(tdr.error_of(format('select * from public.trash_delete_forever(%L, %L)', :'co', jsonb_build_array(jsonb_build_object('kind', 'file', 'id', :'survey'))))
  = '42501: Only owners can delete things for good.', 'office staff can''t delete anything for good');
select tdr.as_user(:'ann');
select tdr.check(tdr.error_of('select * from public.trash_purge(now(), 10)') like '42501:%', 'nobody signed in purges the Trash, not even the owner (the server does)');
select tdr.check(tdr.error_of(format('select public.trash_copied_to_drive(%L, %L)', :'co', :'survey')) like '42501:%', 'or takes a file copied into Drive out of it');
commit;
select path as site3_path from public.plan_files where id = :'site3' \gset
select string_agg(path, ',' order by path) as gutter_paths from public.plan_files where id in (:'gutter', :'gutter2') \gset
select string_agg(path, ',' order by path) as prices_paths from public.plan_files where id in (:'spec', :'spec2') \gset
select string_agg(path, ',' order by path) as survey_paths from public.plan_files where id in (:'survey', :'permit') \gset
select id as ticket_trash, path as ticket_path from public.trashed_files where path like '%f1.jpg' \gset
select id as e1_trash from public.trashed_files where path like '%e1.jpg' \gset
insert into public.trashed_files (company_id, path, source) values (:'other', :'other' || '/receipts/theirs.jpg', 'receipt') returning id as theirs_trash \gset
-- The machine's old photo, saved back on it from an older copy of the page: in use again.
update public.equipment set photo_path = :'co' || '/equipment/dd000000-0000-0000-0000-0000000000e1.jpg' where id = :'trailer';

begin;
set local role authenticated;
select tdr.as_user(:'ann');
select string_agg(kind || ':' || tdr.files(paths), ',' order by kind, tdr.files(paths)) as forever, count(*) as forever_items from public.trash_delete_forever(:'co', jsonb_build_array(
  jsonb_build_object('kind', 'version', 'id', :'site3'), jsonb_build_object('kind', 'file', 'id', :'gutter2'), jsonb_build_object('kind', 'folder', 'id', :'prices'),
  jsonb_build_object('kind', 'other', 'id', :'ticket_trash'), jsonb_build_object('kind', 'other', 'id', :'e1_trash'), jsonb_build_object('kind', 'version', 'id', :'site3'),
  -- Not in the Trash, or another company's: left out.
  jsonb_build_object('kind', 'file', 'id', :'site'), jsonb_build_object('kind', 'folder', 'id', :'root'), jsonb_build_object('kind', 'other', 'id', :'site'),
  jsonb_build_object('kind', 'other', 'id', :'theirs_trash'), jsonb_build_object('kind', 'file', 'id', 'not an id'))) \gset
commit;
select tdr.check(:'forever' = 'file:' || replace(:'gutter_paths', ',', '+') || ',folder:' || replace(:'prices_paths', ',', '+')
    || ',other:' || :'ticket_path' || ',other:kept,version:' || :'site3_path',
  'the owner deletes a file with its versions, a version, a folder with its files and stored files of everything else, and the server is handed their files: only those nothing uses');
select tdr.check(:forever_items = 5, 'a row for each thing deleted, so the server can say how many went');
select tdr.check((select superseded_at is null and replaces_id is null from public.plan_files where id = :'site'), 'a version deleted for good leaves the one before as the current one');
select tdr.check(not exists (select 1 from public.plan_files where id in (:'site3', :'gutter', :'gutter2', :'spec', :'spec2'))
  and not exists (select 1 from public.drive_folders where id = :'prices') and not exists (select 1 from public.trashed_files where id in (:'ticket_trash', :'e1_trash')),
  'they''re gone: files, the folder, and the stored files'' places in the Trash');
select tdr.check((select photo_path like '%e1.jpg' from public.equipment where id = :'trailer'), 'the photo in use again stays on its machine');
select tdr.check((select count(*) from public.plan_files where id in (:'survey', :'permit') and deleted_at is not null) = 2
  and exists (select 1 from public.trashed_files where id = :'theirs_trash'), 'what wasn''t asked for, or isn''t theirs, stays');

-- A folder in the Trash holding one in use (it can't, but if it did) isn't deleted, by an owner or
-- the purge: deleting it would delete that one too.
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'root', 'Holder') returning id as holder \gset
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'holder', 'Kid') returning id as kid \gset
select public.drive_trash_folder(:'holder');
commit;
alter table public.drive_folders disable trigger drive_folders_guard;
update public.drive_folders set deleted_at = null, deleted_by = null where id = :'kid';
alter table public.drive_folders enable trigger drive_folders_guard;
begin;
set local role authenticated;
select tdr.as_user(:'ann');
select tdr.check(tdr.error_of(format('select * from public.trash_delete_forever(%L, %L)', :'co', jsonb_build_array(jsonb_build_object('kind', 'folder', 'id', :'holder'))))
  = '22023: A folder in the Trash still has a folder in use inside it. Restore it and move that folder out first.', 'an owner can''t delete a folder still holding one in use');
commit;

-- 30 days on, the purge: everything that went at one moment together (every version), not the
-- folder holding one in use, and a receipt.
begin;
select set_config('crewtavo.trash', 'on', true);
update public.plan_files set deleted_at = deleted_at - interval '40 days' where id in (:'survey', :'permit');
update public.drive_folders set deleted_at = deleted_at - interval '40 days' where id = :'holder';
commit;
update public.trashed_files set deleted_at = deleted_at - interval '40 days' where path like '%b1.jpg';
select path as b1_path from public.trashed_files where path like '%b1.jpg' \gset
set role service_role;
select string_agg(source || ':' || deleted || ':' || tdr.files(paths), ',' order by source) as purged from public.trash_purge(now(), 1) \gset
select coalesce(string_agg(source, ','), 'nothing') as purged_again from public.trash_purge(now(), 1) \gset
reset role;
select tdr.check(:'purged' = 'plan_files:2:' || replace(:'survey_paths', ',', '+') || ',trashed_files:1:' || :'b1_path',
  'the purge deletes both files that went together, even one moment at a time, and a receipt, and hands over their files');
select tdr.check(:'purged_again' = 'nothing' and exists (select 1 from public.drive_folders where id = :'holder'), 'then nothing more is due; the folder holding one in use stays');
select tdr.check(exists (select 1 from public.trashed_files where path like '%c1.jpg'), 'and what''s been there less than 30 days stays, whatever cutoff the server asks for');
set role service_role;
select coalesce(string_agg(source, ','), 'nothing') as purged_early from public.trash_purge(now() + interval '1 year', 1000) \gset
reset role;
select tdr.check(:'purged_early' = 'nothing', 'a cutoff later than 30 days ago is taken as 30 days ago');

-- A folder deleted for good while a file in it was put back on a job keeps the file on the job.
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'root', 'Bids') returning id as bids \gset
insert into public.plan_files (company_id, folder_id, job_id, title, path, file_name) values (:'co', :'bids', :'j1', 'Bid sheet', tdr.path(:'co'), 'bid.pdf') returning id as bid \gset
insert into public.plan_files (company_id, folder_id, title, path, file_name) values (:'co', :'bids', 'Loose bid', tdr.path(:'co'), 'loose.pdf') returning id as loose \gset
select public.drive_trash_folder(:'bids');
select public.drive_restore('file', :'bid');
select public.drive_restore('file', :'loose');
select tdr.check((select folder_id = :'bids' and job_id = :'j1' from public.plan_files where id = :'bid'), 'a file on a job comes back on its job, its folder still in the Trash');
insert into public.plan_files (company_id, replaces_id, folder_id, job_id, title, path, file_name) values (:'co', :'bid', :'bids', :'j1', 'Bid sheet', tdr.path(:'co'), 'bid b.pdf') returning id as bid2 \gset
select tdr.check((select folder_id is null and job_id = :'j1' and replaces_id = :'bid' from public.plan_files where id = :'bid2'),
  'a new version of it goes on the job, not in the folder in the Trash (even when it names that folder)');
commit;
delete from public.drive_folders where id = :'bids';
select tdr.check((select folder_id is null and job_id = :'j1' and deleted_at is null and superseded_at is not null from public.plan_files where id = :'bid'),
  'a file back on its job stays there when its old folder is deleted for good');
select tdr.check((select folder_id = :'root' and deleted_at is null from public.plan_files where id = :'loose'), 'one on nothing came back in Company files');

\o
\echo 'A new version of an archived file'
\o /dev/null

-- ===== A new version of an archived file ========================================================
-- Someone who had a plan open before it was archived saves their markup, or uploads a new version
-- from a list that loaded before: it's archived too, so the crew don't get it back.
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'Old layout', tdr.path(:'co'), 'layout.pdf') returning id as layout \gset
update public.plan_files set archived = true where id = :'layout';
insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (:'co', :'layout', 'Old layout', tdr.path(:'co'), 'layout b.pdf') returning id as layout2 \gset
select tdr.check((select archived and superseded_at is null and job_id = :'j1' from public.plan_files where id = :'layout2'), 'a new version of an archived file is archived too');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'New layout', tdr.path(:'co'), 'new.pdf') returning id as fresh \gset
insert into public.plan_files (company_id, replaces_id, title, path, file_name) values (:'co', :'fresh', 'New layout', tdr.path(:'co'), 'new b.pdf') returning id as fresh2 \gset
select tdr.check((select not archived from public.plan_files where id = :'fresh2'), '(one of a file in use isn''t)');
commit;
select tdr.check((select count(*) from public.notifications where user_id = :'cy' and body like '%New version of Old layout%') = 0
  and (select count(*) from public.notifications where user_id = :'cy' and body like '%New version of New layout%') = 1, 'the crew aren''t told about it');
begin;
set local role authenticated;
select tdr.as_user(:'cy');
select tdr.check(not exists (select 1 from public.plan_files where id in (:'layout', :'layout2')) and exists (select 1 from public.plan_files where id = :'fresh2'),
  'nor can they open it');
rollback;

\o
\echo 'Thousands of files at once'
\o /dev/null

-- ===== Thousands of files at once ===============================================================
-- PostgREST hands the server 1000 rows at most, so a folder of 1,200 files deleted for good is one
-- row with every file in it, not a row a file.
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'root', '2024 jobs') returning id as bulk \gset
insert into public.plan_files (company_id, folder_id, title, path, file_name) select :'co', :'bulk', 'Page ' || g, tdr.path(:'co'), 'page.pdf' from generate_series(1, 1200) g;
select public.drive_trash_folder(:'bulk');
commit;
begin;
set local role authenticated;
select tdr.as_user(:'ann');
with gone as (select * from public.trash_delete_forever(:'co', jsonb_build_array(jsonb_build_object('kind', 'folder', 'id', :'bulk'))))
select (select count(*) from gone) as bulk_rows, (select count(distinct p) from gone, unnest(gone.paths) p) as bulk_files \gset
commit;
select tdr.check(:bulk_rows = 1 and :bulk_files = 1200, 'an owner deleting a folder of 1,200 files for good gets one row, with every one of its files');
select tdr.check(not exists (select 1 from public.drive_folders where id = :'bulk') and not exists (select 1 from public.plan_files where title like 'Page %'), '(they''re gone)');

-- The purge: 1,200 files that went together, their folder and 1,100 files from elsewhere (one of them
-- another company's), 30 days on. A row for each kind and company, with every file.
begin;
set local role authenticated;
select tdr.as_user(:'ola');
insert into public.drive_folders (company_id, parent_id, name) values (:'co', :'root', '2023 jobs') returning id as bulk \gset
insert into public.plan_files (company_id, folder_id, title, path, file_name) select :'co', :'bulk', 'Page ' || g, tdr.path(:'co'), 'page.pdf' from generate_series(1, 1200) g;
select public.drive_trash_folder(:'bulk');
commit;
begin;
select set_config('crewtavo.trash', 'on', true);
update public.plan_files set deleted_at = deleted_at - interval '40 days' where folder_id = :'bulk';
update public.drive_folders set deleted_at = deleted_at - interval '40 days' where id = :'bulk';
commit;
insert into public.trashed_files (company_id, path, source, deleted_at)
  select :'co', :'co' || '/receipts/bulk-' || g || '.jpg', 'receipt', now() - interval '40 days' + g * interval '1 second' from generate_series(1, 1099) g;
insert into public.trashed_files (company_id, path, source, deleted_at) values (:'other', :'other' || '/receipts/bulk.jpg', 'receipt', now() - interval '50 days');
set role service_role;
with purged as (select * from public.trash_purge(now(), 1000))
select (select count(*) from purged) as purge_rows,
  (select string_agg(source || ':' || deleted || ':' || cardinality(paths), ',' order by source, deleted) from purged where company_id = :'co') as purge_ours,
  (select string_agg(source || ':' || deleted || ':' || tdr.files(paths), ',') from purged where company_id = :'other') as purge_theirs,
  (select count(distinct p) from purged, unnest(purged.paths) p) as purge_files \gset
with purged as (select * from public.trash_purge(now(), 1000))
select (select string_agg(source || ':' || deleted || ':' || cardinality(paths), ',') from purged) as purge_rest \gset
select coalesce(string_agg(source, ','), 'nothing') as purge_done from public.trash_purge(now(), 1000) \gset
reset role;
select tdr.check(:purge_rows = 4 and :'purge_ours' = 'drive_folders:1:0,plan_files:1200:1200,trashed_files:999:999'
  and :'purge_theirs' = 'trashed_files:1:' || :'other' || '/receipts/bulk.jpg' and :purge_files = 1200 + 999 + 1,
  'the purge hands over every file of 2,200 rows deleted in four rows: plan files, the folder and the files from elsewhere of one company, and another''s');
select tdr.check(:'purge_rest' = 'trashed_files:100:100' and :'purge_done' = 'nothing', 'the rest the next time, then nothing');

-- A row a company: 300 companies at most each time (three kinds each stay under 1000 rows).
insert into public.companies (name, slug) select 'Firm ' || g, 'tdr-firm-' || g from generate_series(1, 301) g;
insert into public.trashed_files (company_id, path, source, deleted_at)
  select c.id, c.id || '/receipts/old.jpg', 'receipt', now() - interval '40 days' from public.companies c where c.slug like 'tdr-firm-%';
set role service_role;
select count(*) as firm_rows, sum(cardinality(paths)) as firm_files from public.trash_purge(now(), 1000) \gset
select count(*) as firm_rest from public.trash_purge(now(), 1000) \gset
reset role;
select tdr.check(:firm_rows = 300 and :firm_files = 300 and :firm_rest = 1, 'the purge takes 300 companies at a time, and the rest the next time');
delete from public.companies where slug like 'tdr-firm-%';

\o
\echo 'An applicant''s files are their own'
\o /dev/null

-- ===== An applicant's files are their own =======================================================
-- Stored in their own folder, as the careers form and the office store them: so whether a file is
-- in use is one look at one applicant, however many there are.
begin;
set local role authenticated;
select tdr.as_user(:'ann');
select tdr.check(tdr.error_of(format('update public.job_applicants set files = files || %L where id = %L',
    jsonb_build_array(jsonb_build_object('path', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d1/1.pdf', 'name', 'cv.pdf')), :'applicant'))
  = '22023: That file isn''t stored with this applicant. Add it again.', 'an applicant can''t list a file stored with another applicant');
select tdr.expect_error(format('update public.job_applicants set files = files || %L where id = %L', jsonb_build_array(jsonb_build_object('path', :'truss_path')), :'applicant'),
  'or a plan''s file');
select tdr.expect_error(format('update public.job_applicants set files = files || %L where id = %L',
  jsonb_build_array(jsonb_build_object('path', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d0/../dd000000-0000-0000-0000-0000000000d1/1.pdf')), :'applicant'),
  'or climb out of their folder');
select tdr.expect_error(format('insert into public.job_applicants (company_id, name, files) values (%L, %L, %L)', :'co', 'Sly Applicant',
  jsonb_build_array(jsonb_build_object('path', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d0/1.pdf', 'name', 'resume.pdf'))), 'a new applicant can''t either');
insert into public.job_applicants (id, company_id, name, files) values ('dd000000-0000-0000-0000-0000000000d2', :'co', 'New Applicant',
  jsonb_build_array(jsonb_build_object('path', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d2/1.pdf', 'name', 'cv.pdf', 'type', 'application/pdf', 'size', 10)));
select tdr.check(exists (select 1 from public.job_applicants where name = 'New Applicant'), '(their own, as the office adds them)');
commit;
select tdr.check(private.stored_path_in_use(:'co', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d0/1.pdf'), 'a file an applicant lists is in use');
select tdr.check(not private.stored_path_in_use(:'co', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d0/9.pdf')
  and not private.stored_path_in_use(:'co', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d1/1.pdf')
  and not private.stored_path_in_use(:'co', :'co' || '/applicants/not-an-id/1.pdf'), 'one they don''t isn''t, nor one whose applicant is gone');
-- A file listed from before, stored with someone else: the rest of their files still change, and
-- taking it off doesn't put it in the Trash (it isn't theirs to hand over).
alter table public.job_applicants disable trigger applicant_files_guard;
update public.job_applicants set files = files || jsonb_build_array(jsonb_build_object('path', :'co' || '/applicants/dd000000-0000-0000-0000-0000000000d2/2.pdf', 'name', 'old.pdf'))
  where id = :'applicant';
alter table public.job_applicants enable trigger applicant_files_guard;
begin;
set local role authenticated;
select tdr.as_user(:'ann');
update public.job_applicants set notes = 'Called back', files = files where id = :'applicant';
update public.job_applicants set files = files - 2 where id = :'applicant';
commit;
select tdr.check((select jsonb_array_length(files) = 2 and notes = 'Called back' from public.job_applicants where id = :'applicant')
  and not exists (select 1 from public.trashed_files where path like '%d2/2.pdf'), 'one listed from before, stored with someone else, comes off without going in the Trash');

\o
\echo 'Uploads nobody recorded'
\o /dev/null

-- ===== Uploads nobody recorded ===================================================================
-- A guide's cover, or a quote's or a visit's photo, uploaded for a save that then failed: over a day
-- old, used by nothing and not in the Trash. Only in those three folders.
insert into storage.buckets (id, name) values ('elsewhere', 'elsewhere');
insert into public.sop_pages (company_id, title, status, cover_path) values (:'co', 'Roof jacks', 'published', :'co' || '/kb/ee000000-0000-0000-0000-000000000001.jpg');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/ee000000-0000-0000-0000-000000000003.jpg', 'kept.jpg');
insert into public.trashed_files (company_id, path, source, label) values (:'co', :'co' || '/visit/' || :'v1' || '/ee000000-0000-0000-0000-000000000004.jpg', 'visit_photo', 'Visit photo');
-- (Named by another row of anything: a machine's photo, say.)
update public.equipment set photo_path = :'co' || '/visit/' || :'v1' || '/ee000000-0000-0000-0000-00000000000f.jpg' where id = :'trailer';
insert into storage.objects (bucket_id, name, created_at) values
  ('files', :'co' || '/kb/ee000000-0000-0000-0000-000000000001.jpg', now() - interval '3 days'),
  ('files', :'co' || '/kb/ee000000-0000-0000-0000-000000000002.jpg', now() - interval '2 days'),
  ('files', :'co' || '/visit/' || :'v1' || '/ee000000-0000-0000-0000-000000000003.jpg', now() - interval '2 days'),
  ('files', :'co' || '/visit/' || :'v1' || '/ee000000-0000-0000-0000-000000000004.jpg', now() - interval '40 days'),
  ('files', :'co' || '/visit/' || :'v1' || '/ee000000-0000-0000-0000-000000000005.jpg', now() - interval '2 days'),
  ('files', :'co' || '/visit/' || :'v1' || '/ee000000-0000-0000-0000-000000000006.jpg', now() - interval '2 hours'),
  ('files', :'co' || '/quote/' || :'q1' || '/ee000000-0000-0000-0000-000000000007.jpg', now() - interval '2 days'),
  ('files', :'co' || '/visit/' || :'v1' || '/ee000000-0000-0000-0000-00000000000f.jpg', now() - interval '2 days'),
  ('files', :'co' || '/plans/ee000000-0000-0000-0000-000000000008.pdf', now() - interval '2 days'),
  ('files', :'co' || '/receipts/ee000000-0000-0000-0000-000000000009.jpg', now() - interval '2 days'),
  ('files', :'co' || '/client/' || :'c1' || '/ee000000-0000-0000-0000-00000000000a.jpg', now() - interval '2 days'),
  ('files', :'co' || '/visits/ee000000-0000-0000-0000-00000000000b.jpg', now() - interval '2 days'),
  ('files', :'co' || '/kb/../plans/ee000000-0000-0000-0000-000000000008.pdf', now() - interval '2 days'),
  ('elsewhere', :'co' || '/kb/ee000000-0000-0000-0000-00000000000c.jpg', now() - interval '2 days'),
  ('files', 'nobody/kb/ee000000-0000-0000-0000-00000000000d.jpg', now() - interval '2 days'),
  ('files', :'other' || '/kb/ee000000-0000-0000-0000-00000000000e.jpg', now() - interval '2 days');
set role service_role;
select string_agg(company_id || ':' || tdr.files(paths), ',' order by company_id = :'co' desc) as strays, count(*) as stray_rows from public.unrecorded_files(1000) \gset
select count(*) as one_row, sum(cardinality(paths)) as one_file from public.unrecorded_files(1) \gset
reset role;
select tdr.check(:'strays' = :'co' || ':' || :'co' || '/kb/ee000000-0000-0000-0000-000000000002.jpg+' || :'co' || '/quote/' || :'q1' || '/ee000000-0000-0000-0000-000000000007.jpg+'
    || :'co' || '/visit/' || :'v1' || '/ee000000-0000-0000-0000-000000000005.jpg,' || :'other' || ':' || :'other' || '/kb/ee000000-0000-0000-0000-00000000000e.jpg' and :stray_rows = 2,
  'the server is handed covers and photos nobody recorded, a day on, a row a company: not one in use, in the Trash, on its way, in another folder or bucket, or no company''s');
select tdr.check(:one_row = 1 and :one_file = 1, 'as many as it asks for');
begin;
set local role authenticated;
select tdr.as_user(:'ann');
select tdr.check(tdr.error_of('select * from public.unrecorded_files(10)') like '42501:%', 'nobody signed in asks for them, not even an owner (the server does)');
commit;

\o
\echo 'A category''s cover photo'
\o /dev/null

-- ===== A category's cover photo ==================================================================
-- Kept like a guide's: in use while its category has it, so the tidy-up never takes it, and into
-- the Trash once it's replaced or the category is removed.
insert into public.sop_categories (company_id, name, cover_path) values (:'co', 'Driveways', :'co' || '/kb/ee000000-0000-0000-0000-000000000011.jpg') returning id as category \gset
insert into public.sop_categories (company_id, name, cover_path) values (:'co', 'Gutters', :'co' || '/kb/ee000000-0000-0000-0000-000000000013.jpg') returning id as category2 \gset
insert into storage.objects (bucket_id, name, created_at) values
  ('files', :'co' || '/kb/ee000000-0000-0000-0000-000000000011.jpg', now() - interval '3 days'),
  ('files', :'co' || '/kb/ee000000-0000-0000-0000-000000000013.jpg', now() - interval '3 days');
select tdr.check(private.stored_path_in_use(:'co', :'co' || '/kb/ee000000-0000-0000-0000-000000000011.jpg'), 'a category''s cover photo is in use');
set role service_role;
select coalesce(string_agg(tdr.files(paths), ','), '') as kb_strays from public.unrecorded_files(1000) where company_id = :'co' \gset
reset role;
select tdr.check(position('000000000011.jpg' in :'kb_strays') = 0 and position('000000000013.jpg' in :'kb_strays') = 0
    and position('000000000002.jpg' in :'kb_strays') > 0,
  'so the tidy-up leaves it, days on, and still takes a cover nobody has');
begin;
set local role authenticated;
select tdr.as_user(:'ann');
update public.sop_categories set cover_path = :'co' || '/kb/ee000000-0000-0000-0000-000000000012.jpg' where id = :'category';
delete from public.sop_categories where id = :'category2';
commit;
select tdr.check((select source = 'kb_cover' and label = 'Category cover · Driveways' and file_name = 'Driveways cover.jpg' and source_id = :'category' and deleted_by = :'ann'
  from public.trashed_files where path like '%000000000011.jpg'), 'one replaced goes in the Trash');
select tdr.check((select label = 'Category cover · Gutters' and source_id = :'category2' from public.trashed_files where path like '%000000000013.jpg'),
  'and so does one whose category is removed');

-- Deleting the company takes everything with it.
insert into public.trashed_files (company_id, path, source) values (:'co', :'co' || '/receipts/last.jpg', 'receipt');
delete from public.companies where id = :'other';
delete from public.companies where id = :'co';
select tdr.check(not exists (select 1 from public.plan_files where company_id in (:'co', :'other')) and not exists (select 1 from public.drive_folders where company_id in (:'co', :'other'))
  and not exists (select 1 from public.trashed_files where company_id in (:'co', :'other')),
  'deleting a company takes its files, folders and Trash with it');

set client_min_messages = warning;
drop schema tdr cascade;
reset client_min_messages;

\o
\echo 'All Drive tests passed.'
