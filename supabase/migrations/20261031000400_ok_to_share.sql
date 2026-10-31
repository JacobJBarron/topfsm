-- OK to share (docs/marketing-plan.md, phase E): a crew member or the office marks a job photo the
-- business may post on its own social pages, and a client can say their property is never posted.
--
--   attachments.shareable*         OK to share, who said so and when. Changed only through
--                                  set_photo_shareable (attachment_share_guard keeps it out of plain
--                                  updates), and a replaced file is never OK to share by itself.
--   clients.social_photos_opt_out  "Don't post photos of this client's property": no photo of theirs
--                                  can be marked, offered for a post or posted.
--   record_photos                  a job's or a client's photos, for the office's Photos card.
--   social_photos                  the photos OK to share, for Marketing → Social's composer.
--
-- Only JPEG and PNG can be posted: the server re-encodes them as JPEG without EXIF in pure
-- JavaScript (apps/api/src/lib/shareImage.ts), and has nothing that reads HEIC or WebP.

-- ---------------------------------------------------------------------------------------------
-- Photos
-- ---------------------------------------------------------------------------------------------

alter table public.attachments
  add column shareable boolean not null default false,
  add column shareable_by uuid references auth.users (id) on delete set null,
  add column shareable_at timestamptz,
  add constraint attachments_shareable_at_check check (not shareable or shareable_at is not null),
  add constraint attachments_shareable_type_check check (not shareable or lower(content_type) in ('image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png'));
comment on column public.attachments.shareable is 'OK to share: the office may post this photo on the business''s social pages';
comment on column public.attachments.shareable_by is 'Who marked it OK to share';
comment on column public.attachments.shareable_at is 'When it was marked OK to share';
create index attachments_shareable_idx on public.attachments (company_id, created_at desc, id desc) where shareable;

-- On while set_photo_shareable writes, for the rest of that statement's transaction.
create function private.share_setting() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('crewtavo.share', true), '') = 'on'
$$;

-- Someone signed in writing a photo keeps OK to share as it was (a new one starts off); only
-- set_photo_shareable changes it. A file replaced (its path or type changed) is a photo nobody
-- okayed, so it's off again, whoever changes it.
create function private.attachment_share_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.path is distinct from old.path or new.content_type is distinct from old.content_type) then
    new.shareable := false;
    new.shareable_by := null;
    new.shareable_at := null;
    return new;
  end if;
  if (select auth.uid()) is not null and not private.share_setting() then
    if tg_op = 'UPDATE' then
      new.shareable := old.shareable;
      new.shareable_by := old.shareable_by;
      new.shareable_at := old.shareable_at;
    else
      new.shareable := false;
      new.shareable_by := null;
      new.shareable_at := null;
    end if;
  end if;
  return new;
end $$;
create trigger attachment_share_guard before insert or update on public.attachments
  for each row execute function private.attachment_share_guard();

-- ---------------------------------------------------------------------------------------------
-- The client's choice
-- ---------------------------------------------------------------------------------------------

alter table public.clients add column social_photos_opt_out boolean not null default false;
comment on column public.clients.social_photos_opt_out is 'Don''t post photos of this client''s property';

-- The client a photo is of: a visit's job's (or its request's, or its property's), or the client of
-- the job, quote, request, property or invoice it's on, or the client it's on. Null when what it's on
-- is gone (attachments have no foreign key to it): such a photo can't be posted.
create function private.attachment_client(p_company uuid, p_owner_type text, p_owner_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case p_owner_type
    when 'client' then (select c.id from public.clients c where c.company_id = p_company and c.id = p_owner_id)
    when 'job' then (select j.client_id from public.jobs j where j.company_id = p_company and j.id = p_owner_id)
    when 'quote' then (select q.client_id from public.quotes q where q.company_id = p_company and q.id = p_owner_id)
    when 'request' then (select r.client_id from public.requests r where r.company_id = p_company and r.id = p_owner_id)
    when 'property' then (select p.client_id from public.properties p where p.company_id = p_company and p.id = p_owner_id)
    when 'invoice' then (select i.client_id from public.invoices i where i.company_id = p_company and i.id = p_owner_id)
    when 'visit' then (
      select coalesce(j.client_id, r.client_id, p.client_id)
        from public.visits v
        left join public.jobs j on j.id = v.job_id
        left join public.requests r on r.id = v.request_id
        left join public.properties p on p.id = v.property_id
       where v.company_id = p_company and v.id = p_owner_id)
  end
$$;

-- The job a photo belongs to: its own, its visit's, or the job its quote became.
create function private.attachment_job(p_company uuid, p_owner_type text, p_owner_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case p_owner_type
    when 'job' then (select j.id from public.jobs j where j.company_id = p_company and j.id = p_owner_id)
    when 'visit' then (select v.job_id from public.visits v where v.company_id = p_company and v.id = p_owner_id)
    when 'quote' then (select j.id from public.jobs j where j.company_id = p_company and j.quote_id = p_owner_id order by j.created_at limit 1)
  end
$$;

-- Why a photo can't be posted: 'format' (not a JPEG or PNG), 'no_client' (what it's on is gone) or
-- 'client_opt_out' (the client said no). Null when it can be.
create function private.photo_share_problem(p_company uuid, p_owner_type text, p_owner_id uuid, p_content_type text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_client uuid;
begin
  if lower(coalesce(p_content_type, '')) not in ('image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png') then return 'format'; end if;
  v_client := private.attachment_client(p_company, p_owner_type, p_owner_id);
  if v_client is null then return 'no_client'; end if;
  if exists (select 1 from public.clients c where c.id = v_client and c.social_photos_opt_out) then return 'client_opt_out'; end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Marking a photo
-- ---------------------------------------------------------------------------------------------

-- OK to share, or not, for anyone on the team (not a sub: a sub isn't a member of the business).
-- Only a JPEG or PNG, of a client who hasn't said no. Turning it off clears who and when.
create function public.set_photo_shareable(p_attachment uuid, p_shareable boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.attachments;
  v_problem text;
begin
  select * into a from public.attachments where id = p_attachment for update;
  if not found or not private.has_role(a.company_id, '{owner,admin,office,estimator,crew_lead,field_crew}') then
    raise exception 'You can''t change this photo' using errcode = '42501';
  end if;
  if p_shareable then
    v_problem := private.photo_share_problem(a.company_id, a.owner_type, a.owner_id, a.content_type);
    if v_problem = 'format' then
      raise exception 'Only JPEG and PNG photos can be posted. Save this one as a JPEG and add it again.' using errcode = '22023';
    elsif v_problem = 'no_client' then
      raise exception 'This photo isn''t on a job, visit or client anymore, so it can''t be posted.' using errcode = '22023';
    elsif v_problem = 'client_opt_out' then
      raise exception 'This client asked us not to post photos of their property.' using errcode = '22023';
    end if;
  end if;
  perform set_config('crewtavo.share', 'on', true);
  update public.attachments
     set shareable = p_shareable,
         shareable_by = case when not p_shareable then null when a.shareable then a.shareable_by else (select auth.uid()) end,
         shareable_at = case when not p_shareable then null when a.shareable then a.shareable_at else now() end
   where id = p_attachment
  returning * into a;
  perform set_config('crewtavo.share', '', true);
  return jsonb_build_object('shareable', a.shareable, 'shareable_at', a.shareable_at, 'shareable_by', a.shareable_by);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Reading them
-- ---------------------------------------------------------------------------------------------

-- A job's photos (its own, its visits' and its quote's) or a client's (everything that's theirs),
-- as the person asking may read them (attachments' own rules), each with whether it can be posted.
create function public.record_photos(p_company uuid, p_job uuid default null, p_client uuid default null)
returns table (
  id uuid, path text, file_name text, content_type text, created_at timestamptz, created_by uuid, shareable boolean, shareable_at timestamptz,
  owner_type text, job_id uuid, job_number bigint, job_title text, visit_id uuid, visit_on date, can_share boolean, cant_share text
)
language sql stable security invoker set search_path = '' as $$
  with found as (
    select a.* from public.attachments a
     where a.company_id = p_company and lower(coalesce(a.content_type, '')) like 'image/%'
       and (
         (p_job is not null and (
           (a.owner_type = 'job' and a.owner_id = p_job)
           or (a.owner_type = 'visit' and a.owner_id in (select v.id from public.visits v where v.company_id = p_company and v.job_id = p_job))
           or (a.owner_type = 'quote' and a.owner_id in (select j.quote_id from public.jobs j where j.company_id = p_company and j.id = p_job and j.quote_id is not null))))
         or (p_client is not null and p_job is null and private.attachment_client(p_company, a.owner_type, a.owner_id) = p_client)
       )
  )
  select f.id, f.path, f.file_name, f.content_type, f.created_at, f.created_by, f.shareable, f.shareable_at, f.owner_type,
         j.id, j.number, j.title, case when f.owner_type = 'visit' then f.owner_id end, v.scheduled_on,
         x.problem is null, x.problem
    from found f
    left join public.visits v on f.owner_type = 'visit' and v.id = f.owner_id
    left join public.jobs j on j.id = private.attachment_job(p_company, f.owner_type, f.owner_id)
    cross join lateral (select private.photo_share_problem(p_company, f.owner_type, f.owner_id, f.content_type) as problem) x
   order by v.scheduled_on desc nulls last, f.created_at desc, f.id desc
   limit 500
$$;

-- The photos OK to share, newest first, a page at a time, for office staff with the marketing area:
-- never a client's who said no, nor one whose job, visit or client is gone. `client_ref` tells photos
-- of one client from another's without saying who. `p_job` narrows it to one job's.
create function public.social_photos(p_company uuid, p_before_at timestamptz default null, p_before_id uuid default null, p_limit integer default 48, p_job uuid default null)
returns table (id uuid, path text, created_at timestamptz, job_id uuid, job_number bigint, job_title text, visit_on date, client_ref text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'marketing')) then
    raise exception 'Only office staff with the marketing area can post photos' using errcode = '42501';
  end if;
  return query
    select a.id, a.path, a.created_at, j.id, j.number, j.title, v.scheduled_on, left(md5(p_company::text || ':' || k.client::text), 12)
      from public.attachments a
      cross join lateral (select private.attachment_client(p_company, a.owner_type, a.owner_id) as client, private.attachment_job(p_company, a.owner_type, a.owner_id) as job) k
      left join public.jobs j on j.id = k.job
      left join public.visits v on a.owner_type = 'visit' and v.id = a.owner_id
     where a.company_id = p_company and a.shareable
       and k.client is not null
       and not exists (select 1 from public.clients c where c.id = k.client and c.social_photos_opt_out)
       and (p_job is null or k.job = p_job)
       and (p_before_at is null or (a.created_at, a.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
     order by a.created_at desc, a.id desc
     limit least(greatest(coalesce(p_limit, 48), 1), 100);
end $$;

-- The photos a post was made with, as they are now, for the server posting it: each one's file, whether
-- it's still OK to share, the client it's of and why it can't be posted, if it can't.
create function public.social_photo_facts(p_company uuid, p_ids uuid[])
returns table (id uuid, path text, content_type text, shareable boolean, client_id uuid, job_id uuid, problem text)
language sql stable security definer set search_path = '' as $$
  select a.id, a.path, a.content_type, a.shareable, private.attachment_client(p_company, a.owner_type, a.owner_id),
         private.attachment_job(p_company, a.owner_type, a.owner_id),
         private.photo_share_problem(p_company, a.owner_type, a.owner_id, a.content_type)
    from public.attachments a
   where a.company_id = p_company and a.id = any (coalesce(p_ids, '{}'))
$$;

revoke all on function private.share_setting(), private.attachment_share_guard(), private.attachment_client(uuid, text, uuid),
  private.attachment_job(uuid, text, uuid), private.photo_share_problem(uuid, text, uuid, text) from public;
-- record_photos runs as the person asking, and reads these.
grant execute on function private.attachment_client(uuid, text, uuid), private.attachment_job(uuid, text, uuid),
  private.photo_share_problem(uuid, text, uuid, text) to authenticated, service_role;
revoke execute on function public.set_photo_shareable(uuid, boolean), public.record_photos(uuid, uuid, uuid),
  public.social_photos(uuid, timestamptz, uuid, integer, uuid) from public, anon;
grant execute on function public.set_photo_shareable(uuid, boolean), public.record_photos(uuid, uuid, uuid),
  public.social_photos(uuid, timestamptz, uuid, integer, uuid) to authenticated, service_role;
revoke execute on function public.social_photo_facts(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.social_photo_facts(uuid, uuid[]) to service_role;

notify pgrst, 'reload schema';
