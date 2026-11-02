-- Admin access is given with the giver's password (supabase/tests/admin_grants_test.sql covers it).
--
-- Changing the Stripe key or the company's email asks for the person's own password, but that only
-- proves they know theirs: a stolen owner's or admin's session could make a second admin whose
-- password it knows, and use that. So admin-level access (adminLevel in packages/core/src/roles.ts)
-- is given through the server, which asks for the password first (apps/api/src/routes/account.ts),
-- and refused when the browser writes it straight to the database:
--
--   private.admin_level()        an owner, or an admin with the apps, settings or team area
--   private.admin_grants         the minute the server opens, once the giver's password checks out
--   public.admin_grant_allow()   opens it                                         (service key only)
--   team_page_guard triggers     on memberships and company_roles, after their other guards
--
-- The server writes with the person's own client, through the minute it opened, so every other rule
-- holds as before (only owners make owners, nobody gives areas they don't have, nobody changes their
-- own role). Security-definer functions (making a business, its starter roles) and the server's own
-- key aren't the browser's role, so they're unaffected.

-- Mirrors adminLevel in packages/core/src/roles.ts. `p_perms` is a custom role's areas (always within
-- its level's), or null for everything the level allows.
create function private.admin_level(p_role public.member_role, p_perms text[]) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(p_role in ('owner', 'admin') and coalesce(p_perms, private.level_permissions(p_role)) && array['apps', 'settings', 'team'], false)
$$;
revoke execute on function private.admin_level(public.member_role, text[]) from public;
grant execute on function private.admin_level(public.member_role, text[]) to authenticated, service_role;

-- Who confirmed their password to give `target` (a person's user_id, or a custom role's id) admin
-- access here, until when.
create table private.admin_grants (
  user_id uuid not null,
  company_id uuid not null,
  target uuid not null,
  expires_at timestamptz not null default now() + interval '1 minute',
  primary key (user_id, company_id, target)
);
alter table private.admin_grants enable row level security;
revoke all on private.admin_grants from public, anon, authenticated, service_role;

-- The server, once the person's password checks out. Old minutes are cleared on the way.
create function public.admin_grant_allow(p_user uuid, p_company uuid, p_target uuid) returns void
language sql security definer set search_path = '' as $$
  delete from private.admin_grants where expires_at < now();
  insert into private.admin_grants (user_id, company_id, target) values (p_user, p_company, p_target)
  on conflict (user_id, company_id, target) do update set expires_at = excluded.expires_at;
$$;
revoke execute on function public.admin_grant_allow(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_grant_allow(uuid, uuid, uuid) to service_role;

-- Whether the signed-in person has an open minute for `p_target` here.
create function private.admin_grant_open(p_company uuid, p_target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.admin_grants g
    where g.user_id = (select auth.uid()) and g.company_id = p_company and g.target = p_target and g.expires_at > now()
  )
$$;
revoke execute on function private.admin_grant_open(uuid, uuid) from public;
grant execute on function private.admin_grant_open(uuid, uuid) to authenticated, service_role;

-- A membership that lands on admin-level access: a new one, a level or custom role changed, or one
-- moved to another account or business. (Taking access away, bringing it back, pay rates and
-- anything else go through as before.) Not security definer: it asks who's writing.
create function private.membership_admin_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_role public.member_role;
  v_perms text[];
begin
  if current_user <> 'authenticated' then return new; end if;
  -- A custom role sets the level (role_level did, before this); its areas are its own.
  select r.base_role, r.permissions into v_role, v_perms
  from public.company_roles r where new.role_id is not null and r.id = new.role_id and r.company_id = new.company_id;
  v_role := coalesce(v_role, new.role);
  if private.admin_level(v_role, v_perms)
     and (tg_op = 'INSERT' or new.user_id <> old.user_id or new.company_id <> old.company_id
          or v_role <> old.role or new.role_id is distinct from old.role_id)
     and not private.admin_grant_open(new.company_id, new.user_id) then
    raise exception 'Give admin access from Settings → People' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger team_page_guard before insert or update on public.memberships
  for each row execute function private.membership_admin_guard();

-- A custom role that becomes admin-level (a new one, or new areas or level), whether or not anyone
-- has it yet. Deleting a role gives its people every area of their level, so a role based on admin
-- that people have is only deleted once they're moved off it.
create function private.company_role_admin_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if not private.admin_level(old.base_role, old.permissions) and private.admin_level(old.base_role, null)
       and exists (select 1 from public.memberships m where m.role_id = old.id) then
      raise exception 'Move its people to another role first: deleting it would give them admin access' using errcode = '42501';
    end if;
    return old;
  end if;
  if private.admin_level(new.base_role, new.permissions)
     and (tg_op = 'INSERT' or not private.admin_level(old.base_role, old.permissions))
     and not private.admin_grant_open(new.company_id, new.id) then
    raise exception 'Give admin access from Settings → People' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger team_page_guard before insert or update or delete on public.company_roles
  for each row execute function private.company_role_admin_guard();
