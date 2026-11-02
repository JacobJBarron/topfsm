-- A knowledge base category's cover photo (20261101000600_category_covers.sql) is kept as a guide's
-- is. Nothing asking whether a stored file is used knew about sop_categories.cover_path, so the
-- nightly tidy-up (unrecorded_files) took a category's cover for one uploaded for a failed save and
-- deleted it a day later. And a replaced or removed one now goes to the Trash with its category, by
-- the same triggers as a guide's, since only the server deletes stored files. As in
-- 20261028000300_drive.sql, plus sop_categories in each.

create or replace function private.stored_path_in_use(p_company uuid, p_path text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_folder text := split_part(p_path, '/', 2);
  -- The applicant, channel or person whose folder it's in.
  v_owner uuid := case when split_part(p_path, '/', 3) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then split_part(p_path, '/', 3)::uuid end;
  v_file jsonb := jsonb_build_array(jsonb_build_object('path', p_path));
begin
  if exists (select 1 from public.plan_files f where f.path = p_path)
     or exists (select 1 from public.attachments a where a.path = p_path)
     or exists (select 1 from public.sub_documents d where d.path = p_path)
     or exists (select 1 from public.expenses e where e.receipt_path = p_path)
     or exists (select 1 from public.sop_pages s where s.cover_path = p_path)
     or exists (select 1 from public.sop_categories c where c.cover_path = p_path)
     or exists (select 1 from public.equipment e where e.photo_path = p_path)
     or exists (select 1 from public.job_materials m where m.photo_path = p_path)
     or exists (select 1 from public.measurements m where m.snapshot_path = p_path) then
    return true;
  end if;
  return case v_folder
    -- An applicant's file is only ever on that applicant (applicant_files_guard).
    when 'applicants' then v_owner is not null
      and exists (select 1 from public.job_applicants a where a.id = v_owner and a.files @> v_file)
    -- A chat photo is only ever in its own channel's messages (chat_message_guard).
    when 'chat' then v_owner is not null
      and exists (select 1 from public.chat_messages m where m.channel_id = v_owner and m.attachments @> v_file)
    -- Pictures only the server stores, each in its own folder.
    when 'avatars' then v_owner is not null and exists (select 1 from public.profiles p where p.user_id = v_owner and p.avatar_url = p_path)
    when 'logo' then exists (select 1 from public.companies c where c.id = p_company and c.settings -> 'branding' ->> 'logo' = p_path)
    when 'packages' then exists (select 1 from public.roof_packages r where r.picture = p_path)
      or exists (select 1 from public.quote_options o where o.picture = p_path)
    when 'services' then exists (select 1 from public.services s where s.picture = p_path)
    else false
  end;
end $$;

create or replace function private.trash_removed_files() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_label text;
  v_file jsonb;
begin
  -- The whole company going: its files go with it, and nothing is kept.
  if not exists (select 1 from public.companies c where c.id = old.company_id) then
    return null;
  end if;
  case tg_table_name
  -- Photos on a visit (FieldVisitPage) or a quote (the roofing estimate), put back as they were.
  when 'attachments' then
    if tg_op = 'UPDATE' and new.path is not distinct from old.path then
      return null;
    end if;
    -- Only a file stored with what it was on (stored_path_guard), so it can go back there.
    if not starts_with(old.path, old.company_id::text || '/' || old.owner_type || '/' || old.owner_id::text || '/') then
      return null;
    end if;
    if old.owner_type = 'quote' then
      select 'Quote photo · Quote #' || q.number into v_label from public.quotes q where q.id = old.owner_id;
      perform private.trash_stored_file(old.company_id, old.path, old.file_name, old.content_type, old.size_bytes, 'quote_photo', old.owner_id,
        coalesce(v_label, 'Quote photo'), case when tg_op = 'DELETE' then to_jsonb(old) end);
    else
      if old.owner_type = 'visit' then
        select 'Visit photo · ' || coalesce('Job #' || j.number, nullif(trim(v.title), ''), 'Visit') into v_label
        from public.visits v left join public.jobs j on j.id = v.job_id where v.id = old.owner_id;
      end if;
      perform private.trash_stored_file(old.company_id, old.path, old.file_name, old.content_type, old.size_bytes, 'visit_photo', old.owner_id,
        coalesce(v_label, case when old.owner_type = 'visit' then 'Visit photo' else initcap(old.owner_type) || ' file' end),
        case when tg_op = 'DELETE' then to_jsonb(old) end, old.owner_type);
    end if;

  -- A sub's paperwork (removed by the office, or with the sub), put back as it was.
  when 'sub_documents' then
    select 'Paperwork · ' || s.name into v_label from public.subcontractors s where s.id = old.subcontractor_id;
    perform private.trash_stored_file(old.company_id, old.path, old.file_name, old.content_type, old.size_bytes, 'sub_document', old.subcontractor_id,
      coalesce(v_label, 'Paperwork · ' || private.trash_gone_name(old.subcontractor_id) || ' (deleted)', 'Paperwork'), to_jsonb(old));

  -- A receipt (an expense's, or an equipment repair's), taken out or replaced.
  when 'expenses' then
    if old.receipt_path is null or (tg_op = 'UPDATE' and new.receipt_path is not distinct from old.receipt_path) then
      return null;
    end if;
    select concat_ws(' · ', 'Receipt', nullif(trim(old.vendor), ''), 'Job #' || j.number, eq.name) into v_label
    from (select 1) x left join public.jobs j on j.id = old.job_id left join public.equipment eq on eq.id = old.equipment_id;
    perform private.trash_stored_file(old.company_id, old.receipt_path,
      coalesce('Receipt from ' || nullif(trim(old.vendor), ''), 'Receipt') || private.file_ext(old.receipt_path), null, null, 'receipt', old.id, v_label, null);

  -- A guide's cover photo, replaced or with the guide.
  when 'sop_pages' then
    if old.cover_path is null or (tg_op = 'UPDATE' and new.cover_path is not distinct from old.cover_path) then
      return null;
    end if;
    perform private.trash_stored_file(old.company_id, old.cover_path, left(old.title, 200) || ' cover' || private.file_ext(old.cover_path), null, null,
      'kb_cover', old.id, 'Guide cover · ' || old.title, null);

  -- A knowledge base category's cover photo, replaced or with the category.
  when 'sop_categories' then
    if old.cover_path is null or (tg_op = 'UPDATE' and new.cover_path is not distinct from old.cover_path) then
      return null;
    end if;
    perform private.trash_stored_file(old.company_id, old.cover_path, left(old.name, 200) || ' cover' || private.file_ext(old.cover_path), null, null,
      'kb_cover', old.id, 'Category cover · ' || old.name, null);

  -- An applicant's résumé and other files: one taken off, or all of them with the applicant. Each
  -- can go back on the applicant.
  when 'job_applicants' then
    for v_file in
      select e from jsonb_array_elements(old.files) e
      where jsonb_typeof(e) = 'object'
        and (tg_op = 'DELETE' or not exists (select 1 from jsonb_array_elements(new.files) n where n ->> 'path' = e ->> 'path'))
    loop
      perform private.trash_stored_file(old.company_id, v_file ->> 'path', v_file ->> 'name', v_file ->> 'type',
        case when v_file ->> 'size' ~ '^[0-9]{1,15}$' then (v_file ->> 'size')::bigint end,
        'applicant_file', old.id, 'Applicant · ' || old.name, jsonb_build_object('applicant_id', old.id, 'file', v_file));
    end loop;

  -- A machine's photo, replaced or with the machine.
  when 'equipment' then
    if old.photo_path is null or (tg_op = 'UPDATE' and new.photo_path is not distinct from old.photo_path) then
      return null;
    end if;
    perform private.trash_stored_file(old.company_id, old.photo_path, left(old.name, 200) || private.file_ext(old.photo_path), null, null,
      'equipment_photo', old.id, 'Equipment photo · ' || old.name, null);

  -- A plant ticket's photo on a job's materials.
  when 'job_materials' then
    if old.photo_path is null or (tg_op = 'UPDATE' and new.photo_path is not distinct from old.photo_path) then
      return null;
    end if;
    -- With its job: the job is gone by now, so its number comes from trash_parent_gone.
    select concat_ws(' · ', 'Ticket photo', coalesce('Job #' || j.number, private.trash_gone_name(old.job_id) || ' (deleted)')) into v_label
    from (select 1) x left join public.jobs j on j.id = old.job_id;
    perform private.trash_stored_file(old.company_id, old.photo_path,
      coalesce('Ticket ' || nullif(trim(old.ticket), ''), 'Ticket') || private.file_ext(old.photo_path), null, null, 'ticket_photo', old.id, v_label, null);

  -- A measurement's picture, replaced or with the drawing (not listed in the Trash, only kept).
  when 'measurements' then
    if old.snapshot_path is null or (tg_op = 'UPDATE' and new.snapshot_path is not distinct from old.snapshot_path) then
      return null;
    end if;
    perform private.trash_stored_file(old.company_id, old.snapshot_path, left(old.title, 200) || private.file_ext(old.snapshot_path), null, null,
      'measurement_snapshot', old.id, concat_ws(' · ', 'Measurement', nullif(old.title, 'Measurement')), null);

  -- Photos in a chat message that's deleted, or with its channel (not listed in the Trash either).
  when 'chat_messages' then
    for v_file in
      select e from jsonb_array_elements(old.attachments) e
      where jsonb_typeof(e) = 'object'
        and (tg_op = 'DELETE' or not exists (select 1 from jsonb_array_elements(new.attachments) n where n ->> 'path' = e ->> 'path'))
    loop
      perform private.trash_stored_file(old.company_id, v_file ->> 'path', v_file ->> 'name', v_file ->> 'type',
        case when v_file ->> 'size' ~ '^[0-9]{1,15}$' then (v_file ->> 'size')::bigint end, 'chat_file', old.id, 'Chat photo', null);
    end loop;
  else
    null;
  end case;
  return null;
end $$;

create trigger trash_files after delete on public.sop_categories
  for each row when (old.cover_path is not null) execute function private.trash_removed_files();
create trigger trash_replaced_files after update on public.sop_categories
  for each row when (old.cover_path is distinct from new.cover_path) execute function private.trash_removed_files();

create or replace function public.unrecorded_files(p_limit integer default 1000)
returns table (company_id uuid, paths text[])
language sql stable security definer set search_path = '' as $$
  -- What no photo, cover or file in the Trash names, first (a quick look each), and only those asked
  -- about everywhere else.
  with unnamed as materialized (
    select private.path_company(o.name) as company_id, o.name
    from storage.objects o
    where o.bucket_id = 'files'
      and split_part(o.name, '/', 2) in ('kb', 'quote', 'visit')
      and o.created_at < now() - interval '1 day'
      and o.name !~ '(^|/)\.\.?(/|$)'
      and not exists (select 1 from public.attachments a where a.path = o.name)
      and not exists (select 1 from public.sop_pages s where s.cover_path = o.name)
      and not exists (select 1 from public.sop_categories c where c.cover_path = o.name)
      and not exists (select 1 from public.trashed_files t where t.path = o.name)
  )
  select x.company_id, array_agg(x.name order by x.name)
  from (
    select u.company_id, u.name from unnamed u
    where exists (select 1 from public.companies c where c.id = u.company_id)
      and not private.stored_path_in_use(u.company_id, u.name)
    limit least(greatest(coalesce(p_limit, 1000), 1), 1000)
  ) x
  group by x.company_id
$$;
