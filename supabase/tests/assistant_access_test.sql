-- Database tests for AI assistant access (20261019001040_assistant_access.sql, its followups, and
-- 20261019001900_assistant_areas.sql): an assistant's token (one with a client_id claim) only reads
-- unless the person who connected it chose areas it may change, or gave it full access, in the Data
-- API (hooks.before_request, PostgREST's pre-request) and in Storage. Ordinary sign-ins and visitors
-- are left as they were.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1040;
grant usage on schema t1040 to anon, authenticated, service_role;
create function t1040.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1040.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- The error a statement stops with, as "SQLSTATE: message", or 'none'.
create function t1040.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
-- Claims as PostgREST and Storage set them, with the request's method and path.
create function t1040.as_request(p_user uuid, p_client text, p_method text default 'GET', p_path text default '/clients') returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', p_user, 'role', 'authenticated', 'client_id', p_client))::text, true),
         set_config('request.method', p_method, true),
         set_config('request.path', p_path, true);
$$;
-- What the pre-request hook says to a request: 'none' when it goes through.
create function t1040.hook(p_user uuid, p_client text, p_method text, p_path text) returns text language plpgsql as $$
begin
  perform t1040.as_request(p_user, p_client, p_method, p_path);
  return t1040.error_of('select hooks.before_request()');
end $$;
grant execute on all functions in schema t1040 to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b1040000-0000-0000-0000-000000000001', 'owner@kilo.test', '{"full_name": "Kit Owner"}'),
  ('b1040000-0000-0000-0000-000000000002', 'office@kilo.test', '{"full_name": "Ola Office"}');

begin;
set local role authenticated;
select t1040.as_request('b1040000-0000-0000-0000-000000000001', null, 'POST', '/rpc/create_company');
select public.create_company('Kilo Gardens', 'general') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'b1040000-0000-0000-0000-000000000002', 'office');
insert into public.clients (company_id, display_name) values (:'co', 'Kilo client');
insert into public.crews (company_id, name) values (:'co', 'Kilo crew') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', 'b1040000-0000-0000-0000-000000000002');
insert into public.services (company_id, name) values (:'co', 'Kept service') returning id as service \gset
commit;

\set owner 'b1040000-0000-0000-0000-000000000001'
\set office 'b1040000-0000-0000-0000-000000000002'
-- The owner's assistants: one with full access, one that only reads, one that may change the price
-- list and crews, and one connected before any of this existed (no row).
\set full 'c1040000-0000-0000-0000-00000000000a'
\set reading 'c1040000-0000-0000-0000-00000000000b'
\set chosen 'c1040000-0000-0000-0000-00000000000d'
\set earlier 'c1040000-0000-0000-0000-00000000000c'

\o
\echo 'Assistant access'
\o /dev/null

-- People set their own connections, with an ordinary sign-in.
begin;
set local role authenticated;
select t1040.as_request(:'owner', null);
insert into public.assistant_connections (client_id, level, areas) values (:'full', 'full', '{}'), (:'reading', 'full', '{}'), (:'chosen', 'areas', '{prices,crews}');
update public.assistant_connections set level = 'read' where client_id = :'reading';
select t1040.check((select count(*) = 3 and bool_and(user_id = :'owner') from public.assistant_connections), 'a person''s connections are their own');
select t1040.expect_error(format('insert into public.assistant_connections (user_id, client_id, level) values (%L, %L, %L)', :'office', :'earlier', 'full'),
  'nobody gives someone else''s assistant access');
select t1040.expect_error(format('insert into public.assistant_connections (client_id, level, areas) values (%L, %L, %L)', :'earlier', 'areas', '{everything}'),
  'areas are only the ones there are');
select t1040.expect_error(format('insert into public.assistant_connections (client_id, level) values (%L, %L)', :'earlier', 'admin'),
  'and so are levels');
commit;

begin;
set local role authenticated;
select t1040.as_request(:'office', null);
select t1040.check((select count(*) = 0 from public.assistant_connections), 'nobody else sees them');
update public.assistant_connections set level = 'full' where client_id = :'reading';
commit;
select t1040.check((select level = 'read' from public.assistant_connections where client_id = :'reading'), 'or changes them');

-- An ordinary sign-in is left as it was.
begin;
set local role authenticated;
select t1040.as_request(:'owner', null, 'POST', '/clients');
select hooks.before_request();
select t1040.check(current_setting('transaction_read_only') = 'off', 'an ordinary sign-in can change things');
select t1040.check(t1040.error_of(format('insert into public.clients (company_id, display_name) values (%L, %L)', :'co', 'Signed in')) = 'none', 'and does');
rollback;

-- So are visitors and the server's own key (the hook runs for every request).
begin;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true), set_config('request.method', 'POST', true), set_config('request.path', '/rpc/anything', true);
select hooks.before_request();
reset role;
select t1040.check(current_setting('transaction_read_only') = 'off', 'a visitor''s request goes through as before');
rollback;
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true), set_config('request.method', 'DELETE', true), set_config('request.path', '/clients', true);
select hooks.before_request();
reset role;
select t1040.check(current_setting('transaction_read_only') = 'off', 'and so does the server''s');
rollback;

-- Reading: every assistant reads what its person can, in a request that can't change anything.
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'full', 'GET', '/clients');
select hooks.before_request();
select t1040.check((select count(*) = 1 from public.clients where company_id = :'co'), 'an assistant sees what its person sees');
select t1040.check(current_setting('transaction_read_only') = 'on', 'in a request that can''t change anything, even with full access');
rollback;

-- Read only: switched back, or connected before any of this existed.
begin;
set local role authenticated;
select t1040.check(e = 'PT403: This assistant can''t change the price list. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.',
  'a read-only assistant can''t add to the price list, and is told where to allow it: ' || e) from (select t1040.hook(:'owner', :'reading', 'POST', '/services') as e) x;
select t1040.check(t1040.hook(:'owner', :'reading', 'PATCH', '/requests') like 'PT403: This assistant can''t change requests and notes.%', 'or change a request');
select t1040.check(t1040.hook(:'owner', :'reading', 'DELETE', '/services') like 'PT403: This assistant can''t change the price list.%', 'or delete anything');
select t1040.check(t1040.hook(:'owner', :'earlier', 'POST', '/services') like 'PT403:%', 'nor can one connected before any of this');
rollback;

-- Chosen areas: adds and changes there, nowhere else, and doesn't delete.
begin;
set local role authenticated;
select t1040.check(t1040.hook(:'owner', :'chosen', 'POST', '/services') = 'none', 'an assistant may add to an area it was given');
select t1040.check(current_setting('transaction_read_only') = 'off', 'in a request that can write');
select t1040.check(t1040.error_of(format('insert into public.services (company_id, name) values (%L, %L)', :'co', 'By an assistant')) = 'none', 'and adds a service');
select t1040.check(t1040.hook(:'owner', :'chosen', 'PATCH', '/crews') = 'none', 'and changes a crew');
select t1040.check(t1040.hook(:'owner', :'chosen', 'DELETE', '/crew_members') = 'none', 'and takes someone off a crew, which isn''t deleting');
select t1040.check(t1040.hook(:'owner', :'chosen', 'DELETE', '/services') like 'PT403: This assistant can''t delete things.%', 'but doesn''t delete a service');
select t1040.check(t1040.hook(:'owner', :'chosen', 'POST', '/automation_rules') like 'PT403: This assistant can''t change automations.%', 'or change an area it wasn''t given');
rollback;

-- Full access: everything in every area, deleting too.
begin;
set local role authenticated;
select t1040.check(t1040.hook(:'owner', :'full', 'DELETE', '/services') = 'none', 'full access deletes');
select t1040.check(t1040.error_of(format('delete from public.services where id = %L', :'service')) = 'none', 'a service');
select t1040.check(t1040.hook(:'owner', :'full', 'POST', '/sop_pages') = 'none', 'and writes guides');
rollback;

-- Outside every area, whatever it's been given.
begin;
set local role authenticated;
select t1040.check(t1040.hook(:'owner', :'full', 'POST', '/notifications') = 'PT403: An AI assistant can''t change this. Do it in Crewtavo itself.', 'not even full access writes outside every area');
select t1040.check(t1040.hook(:'owner', :'full', 'PATCH', '/integrations') like 'PT403:%', 'like connected apps and keys');
select t1040.check(t1040.hook(:'owner', :'full', 'PATCH', '/assistant_connections') like 'PT403:%', 'or anyone''s assistant access');
rollback;

-- The rest of Crewtavo, and full access without money.
\set nomoney 'c1040000-0000-0000-0000-00000000000e'
\set quoting 'c1040000-0000-0000-0000-00000000000f'
begin;
set local role authenticated;
select t1040.as_request(:'owner', null);
insert into public.assistant_connections (client_id, level, areas) values (:'nomoney', 'full_no_money', '{}'), (:'quoting', 'areas', '{quotes,clients}');
commit;

begin;
set local role authenticated;
select t1040.check(t1040.hook(:'owner', :'full', 'POST', '/clients') = 'none', 'full access adds clients');
select t1040.check(t1040.hook(:'owner', :'full', 'PATCH', '/memberships') = 'none', 'and changes people');
select t1040.check(t1040.hook(:'owner', :'full', 'DELETE', '/payments') = 'none', 'and gets as far as a payment (the payments guard stops it)');
select t1040.check(t1040.hook(:'owner', :'nomoney', 'POST', '/clients') = 'none', 'full access without money adds clients');
select t1040.check(t1040.hook(:'owner', :'nomoney', 'DELETE', '/jobs') = 'none', 'deletes a job');
select t1040.check(t1040.hook(:'owner', :'nomoney', 'POST', '/company_roles') = 'none', 'and saves roles');
select t1040.check(e = 'PT403: This assistant can''t change money: quotes, invoices, payments, pay or promo codes. To let it, give it Full access in Crewtavo, under Settings → AI assistants.',
  'but doesn''t touch invoices: ' || e) from (select t1040.hook(:'owner', :'nomoney', 'POST', '/invoices') as e) x;
select t1040.check(t1040.hook(:'owner', :'nomoney', 'PATCH', '/quotes') like 'PT403: This assistant can''t change money%', 'quotes');
select t1040.check(t1040.hook(:'owner', :'nomoney', 'POST', '/pay_periods') like 'PT403: This assistant can''t change money%', 'or pay');
select t1040.check(t1040.hook(:'owner', :'quoting', 'POST', '/quote_line_items') = 'none', 'an assistant given quotes changes them');
select t1040.check(t1040.hook(:'owner', :'quoting', 'PATCH', '/visits') like 'PT403: This assistant can''t change the schedule.%', 'and nothing it wasn''t given');
-- Estimate templates and marketing are setup; a promo code is a discount, so it's money.
select t1040.check(t1040.hook(:'owner', :'nomoney', 'PATCH', '/document_templates') = 'none', 'full access without money changes estimate templates');
select t1040.check(t1040.hook(:'owner', :'nomoney', 'DELETE', '/contract_sections') = 'none', 'and contract terms');
select t1040.check(t1040.hook(:'owner', :'nomoney', 'POST', '/campaigns') = 'none', 'and campaigns');
select t1040.check(t1040.hook(:'owner', :'nomoney', 'POST', '/promo_codes') like 'PT403: This assistant can''t change money%', 'but not promo codes');
select t1040.check(t1040.hook(:'owner', :'quoting', 'POST', '/contract_sections') like 'PT403: This assistant can''t change estimate templates and contract terms.%', 'nor an assistant not given templates');
select t1040.check(t1040.hook(:'owner', :'quoting', 'POST', '/campaigns') like 'PT403: This assistant can''t change campaigns, reviews and social posts.%', 'or marketing');
select t1040.check(t1040.hook(:'owner', :'quoting', 'POST', '/social_posts') like 'PT403: An AI assistant can''t change this.%', 'and social posts are only the server''s to write');
rollback;

-- Two functions write for their area; the rest still can't. (The hook runs directly here: a read-only
-- setting made inside error_of's block wouldn't outlast it.)
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'quoting', 'POST', '/rpc/convert_quote_to_job');
select hooks.before_request();
select t1040.check(current_setting('transaction_read_only') = 'off', 'turning a quote into a job can write with quotes');
rollback;
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'quoting', 'POST', '/rpc/create_invoice_for_job');
select hooks.before_request();
select t1040.check(current_setting('transaction_read_only') = 'on', 'invoicing a job needs invoices, so it can''t write');
rollback;
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'nomoney', 'POST', '/rpc/convert_quote_to_job');
select hooks.before_request();
select t1040.check(current_setting('transaction_read_only') = 'on', 'and full access without money can''t turn a quote into a job');
rollback;
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'full', 'POST', '/rpc/create_invoice_for_job');
select hooks.before_request();
select t1040.check(current_setting('transaction_read_only') = 'off', 'full access invoices a job');
rollback;

-- Payments: recorded, never refunded or deleted by an assistant.
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'full', 'POST', '/payments');
select t1040.check(e like '42501: An AI assistant can''t record a refund.%', 'an assistant can''t record a refund: ' || e)
from (select t1040.error_of(format('insert into public.payments (company_id, client_id, amount, method) values (%L, (select id from public.clients where company_id = %L limit 1), -5, %L)', :'co', :'co', 'cash')) as e) x;
rollback;

-- Pay rates need pay; team changes reach the owners.
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'nomoney', 'PATCH', '/memberships');
select t1040.check(t1040.error_of(format('update public.memberships set labor_rate = 31 where company_id = %L and user_id = %L', :'co', :'office')) like '42501: This assistant can''t change pay rates.%',
  'full access without money can''t change a pay rate');
select t1040.check(t1040.error_of(format('update public.memberships set role = %L where company_id = %L and user_id = %L', 'estimator', :'co', :'office')) = 'none', 'but changes a role');
reset role;
select t1040.check((select count(*) = 1 from public.notifications where company_id = :'co' and user_id = :'owner' and kind = 'security' and title = 'An AI assistant changed your team' and body like '%changed % role to Estimator'),
  'and the owner hears about it');
select t1040.check((select count(*) = 1 from public.activity where company_id = :'co' and verb = 'assistant.team'), 'and it''s on record');
rollback;
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'full', 'PATCH', '/memberships');
select t1040.check(t1040.error_of(format('update public.memberships set labor_rate = 31 where company_id = %L and user_id = %L', :'co', :'office')) = 'none', 'full access changes a pay rate');
rollback;

-- Functions it calls answer, but can't write, whatever it's been given.
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'full', 'POST', '/rpc/create_company');
select hooks.before_request();
select t1040.check(e like '25006:%', 'a function an assistant calls can''t write: ' || e)
from (select t1040.error_of(format('insert into public.clients (company_id, display_name) values (%L, %L)', :'co', 'By a function')) as e) x;
select t1040.check(t1040.error_of('select public.create_company(''Sneaky'', ''general'')') like '25006:%', 'not even one that runs as its owner');
select t1040.check(t1040.error_of($$select set_config('transaction_read_only', 'off', true)$$) <> 'none', 'and it can''t make the request writable again');
rollback;

-- An assistant doesn't change anyone's access, its own included.
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'reading', 'PATCH', '/assistant_connections');
update public.assistant_connections set level = 'full' where client_id = :'reading';
update public.assistant_connections set level = 'full' where client_id = :'chosen';
delete from public.assistant_connections where client_id = :'reading';
select t1040.expect_error(format('insert into public.assistant_connections (client_id, level) values (%L, %L)', :'earlier', 'full'), 'an assistant can''t give another one access');
select t1040.check((select count(*) = 1 from public.assistant_connections), 'and sees only its own connection');
commit;
select t1040.check((select level = 'read' from public.assistant_connections where client_id = :'reading'), 'an assistant can''t give itself access, or remove its row');
select t1040.check((select level = 'areas' from public.assistant_connections where client_id = :'chosen'), 'or change another''s');

-- The same app connected by someone else isn't given anything because the owner gave theirs.
begin;
set local role authenticated;
select t1040.check(t1040.hook(:'office', :'full', 'POST', '/services') like 'PT403:%', 'giving one person''s assistant access doesn''t give anyone else''s');
rollback;

-- The company: details and the Settings → Company settings, nothing else.
begin;
set local role authenticated;
select t1040.as_request(:'owner', :'full', 'PATCH', '/companies');
select t1040.check(t1040.error_of(format($$update public.companies set name = 'Kilo Lawns', settings = settings || '{"quote_valid_days": 14, "branding": {"color": "#3b7d23"}}' where id = %L$$, :'co')) = 'none',
  'an assistant with full access changes the company''s details and settings');
select t1040.check(t1040.error_of(format($$update public.companies set settings = settings || '{"assistants": {"enabled": true, "read_only": false}}' where id = %L$$, :'co')) like '42501:%',
  'but not the owner''s limits on assistants');
select t1040.check(t1040.error_of(format($$update public.companies set settings = jsonb_set(settings, '{branding,logo}', '"x"') where id = %L$$, :'co')) like '42501:%',
  'or anything else in its settings');
select t1040.check(t1040.error_of(format($$update public.companies set slug = 'kilo-new' where id = %L$$, :'co')) like '42501:%', 'or its other columns');
rollback;
begin;
set local role authenticated;
select t1040.as_request(:'owner', null, 'PATCH', '/companies');
select t1040.check(t1040.error_of(format($$update public.companies set settings = settings || '{"assistants": {"read_only": true}}' where id = %L$$, :'co')) = 'none', 'the owner still sets them');
rollback;

-- Files: Storage writes with the person's token, through the storage.objects policies.
begin;
set local role authenticated;
select t1040.as_request(:'owner', null, 'POST', '/object/files');
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/notes/kept.txt', :'owner');
select t1040.as_request(:'owner', :'reading', 'POST', '/object/files');
select t1040.check(e like '42501:%', 'a read-only assistant can''t upload a file: ' || e)
from (select t1040.error_of(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/notes/new.txt', :'owner')) as e) x;
select t1040.as_request(:'owner', :'chosen', 'POST', '/object/files');
select t1040.check(t1040.error_of(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/notes/new.txt', :'owner')) like '42501:%', 'nor can one given areas');
delete from storage.objects where name = :'co' || '/notes/kept.txt';
select t1040.check((select count(*) = 1 from storage.objects where name = :'co' || '/notes/kept.txt'), 'or delete one');
select t1040.as_request(:'owner', :'full', 'POST', '/object/files');
select t1040.check(t1040.error_of(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/notes/new.txt', :'owner')) = 'none', 'one with full access can upload');
delete from storage.objects where name = :'co' || '/notes/kept.txt';
select t1040.check((select count(*) = 1 from storage.objects where name = :'co' || '/notes/kept.txt'),
  'but not delete: nobody signed in deletes a stored file (the server deletes them from the Trash)');
rollback;

\o
\echo 'All assistant access tests passed.'
