-- Crewtavo - Marketing becomes a built-in app (docs/marketing-plan.md, phase A), like Drive, Team
-- Chat and Careers: listed in Apps, with Marketing in the sidebar while it's installed. Uninstalling
-- hides Marketing and stops every automatic message it sends to clients (review asks and their
-- reminders, scheduled campaigns); nothing is deleted, and links already sent keep working.
--
--   settings.marketing   installed or not ({enabled, changed_at}). Every business has it installed
--                        when this ships, and new ones start with it on. Owners and admins who
--                        connect apps change it with marketing_set_enabled, and nothing else
--                        signed in can (marketing_settings_guard): a page saving the company's other
--                        settings from a copy it read a while ago keeps it as it is, so it can't put
--                        Marketing back on after someone uninstalled it.

-- ---------------------------------------------------------------------------------------------
-- Installed for everyone
-- ---------------------------------------------------------------------------------------------

-- create_company doesn't pass settings, so a new company starts with Marketing on.
alter table public.companies alter column settings set default '{"marketing": {"enabled": true}}';

-- Turns Marketing on for every company that has never had the switch, and says how many. A company
-- that uninstalled it keeps it off.
create function private.install_marketing() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.companies
     set settings = jsonb_set(coalesce(settings, '{}'), '{marketing}', '{"enabled": true}')
   where jsonb_typeof(settings -> 'marketing') is distinct from 'object';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.install_marketing() from public;

-- ---------------------------------------------------------------------------------------------
-- Only the switch changes it
-- ---------------------------------------------------------------------------------------------

-- On while marketing_set_enabled writes, for the rest of that statement's transaction.
create function private.marketing_setting() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('crewtavo.marketing', true), '') = 'on'
$$;

-- Someone signed in saving settings keeps settings.marketing as it was, as storage_settings_guard
-- does for the storage limit. The server and migrations have nobody signed in, so they go through.
create function private.marketing_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.marketing_setting() or (select auth.uid()) is null
     or new.settings -> 'marketing' is not distinct from old.settings -> 'marketing' then
    return new;
  end if;
  new.settings := case when old.settings -> 'marketing' is null then coalesce(new.settings, '{}') - 'marketing'
    else jsonb_set(coalesce(new.settings, '{}'), '{marketing}', old.settings -> 'marketing') end;
  return new;
end $$;
create trigger marketing_settings_guard before update of settings on public.companies
  for each row execute function private.marketing_settings_guard();

select private.install_marketing();

-- ---------------------------------------------------------------------------------------------
-- The app's switch
-- ---------------------------------------------------------------------------------------------

-- Install and Uninstall, as drive_set_enabled. Uninstalling stops every reminder still to come for
-- good (review_requests.next_reminder_at, 20261030000300_review_reminders.sql): installing again
-- doesn't send them late. Everything else is kept.
create function public.marketing_set_enabled(p_company uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can install Marketing' using errcode = '42501';
  end if;
  perform set_config('crewtavo.marketing', 'on', true);
  update public.companies
     set settings = jsonb_set(coalesce(settings, '{}'), '{marketing}',
       (case when jsonb_typeof(settings -> 'marketing') = 'object' then settings -> 'marketing' else '{}'::jsonb end)
         || jsonb_build_object('enabled', p_enabled, 'changed_at', now()))
   where id = p_company;
  perform set_config('crewtavo.marketing', '', true);
  if not p_enabled then
    update public.review_requests
       set next_reminder_at = null, reminder_note = 'Marketing was uninstalled'
     where company_id = p_company and next_reminder_at is not null;
  end if;
  return p_enabled;
end $$;

revoke all on function private.marketing_setting(), private.marketing_settings_guard() from public;
revoke execute on function public.marketing_set_enabled(uuid, boolean) from public, anon;
grant execute on function public.marketing_set_enabled(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
