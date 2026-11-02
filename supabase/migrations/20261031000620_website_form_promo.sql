-- Website forms keep promo codes (docs/marketing-plan.md, "Promo code fixes"). A field named promo,
-- coupon, promo_code or discount_code (packages/core/src/websiteForms.ts) is checked the way a booking
-- form's is: a valid code waits on the request (requests.promo_code), so the quote page offers it
-- with Apply. One that isn't valid never loses the message: the request is made, the code stays
-- among its answers, and the request says what was typed and why it wasn't applied, for the office.
--
--   requests.rejected_promo_code  the code as typed (trimmed), when it wasn't valid
--   requests.promo_problem        why, in the office's words ("That code expired on October 1.")

alter table public.requests
  add column rejected_promo_code text check (char_length(rejected_promo_code) <= 40),
  add column promo_problem text check (char_length(promo_problem) <= 200);
comment on column public.requests.rejected_promo_code is 'A promo code a website form sent that wasn''t valid, as typed. A valid one is promo_code.';
comment on column public.requests.promo_problem is 'Why rejected_promo_code wasn''t applied, for the office.';

-- As in 20261026000100_website_forms.sql, with p_promo: the code is checked once the client is
-- known (private.find_promo). A new lead has no client yet, so as on a booking form only the code's
-- own rules apply (once per client and new customers only wait for the quote); a client Crewtavo
-- already has is checked as theirs. What's kept is the code as find_promo spells it, never the typed
-- text. Returns promo_code, rejected_promo_code and promo_problem too.
drop function public.website_form_request(uuid, text, text, text, text, jsonb, text, text, jsonb, jsonb, jsonb);
create function public.website_form_request(
  p_form uuid, p_name text default null, p_email text default null, p_phone text default null, p_company_name text default null,
  p_address jsonb default '{}', p_title text default null, p_details text default null, p_answers jsonb default '{}',
  p_contact jsonb default '{}', p_web_visit jsonb default null, p_promo text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f public.website_forms;
  -- A whole address only, as emailKey() in packages/core/src/email.ts takes them.
  v_email text := (select k from private.email_key(p_email) k where k ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(k) <= 254);
  v_phone text := private.phone_e164(p_phone);
  v_line1 text := nullif(trim(p_address ->> 'line1'), '');
  v_promo text := left(nullif(trim(p_promo), ''), 40);
  v_client uuid;
  v_property uuid;
  v_new_property boolean := false;
  v_matched boolean := false;
  v_code text;
  v_problem text;
  v_request public.requests;
begin
  select * into f from public.website_forms where id = p_form;
  if not found then
    raise exception 'Form not found' using errcode = 'P0002';
  end if;
  if v_email is null and v_phone is null and nullif(trim(p_phone), '') is null then
    raise exception 'An email or phone number is needed' using errcode = '22023';
  end if;

  select c.id into v_client
  from public.clients c
  where c.company_id = f.company_id
    and ((v_email is not null and private.email_key(c.email) = v_email) or (v_phone is not null and private.phone_e164(c.phone) = v_phone))
  order by (v_email is not null and private.email_key(c.email) = v_email) desc, c.status = 'archived', c.created_at
  limit 1;
  v_matched := v_client is not null;

  -- Checked before a new lead is made, so a new lead is checked as one.
  if v_promo is not null then
    begin
      v_code := (private.find_promo(f.company_id, case when v_matched then v_client end, v_promo, null)).code;
    exception when sqlstate '22023' then
      -- find_promo's words are for the client; the request says it for the office.
      v_problem := left(case
        when sqlerrm like 'That code isn''t valid%' then 'There''s no active code with that name.'
        when sqlerrm like 'That code has already been used for this account%' then 'This client has already used that code.'
        when sqlerrm like 'That code is for new customers%' then 'That code is for new customers, and this client has worked with you before.'
        else sqlerrm end, 200);
    end;
  end if;

  if not v_matched then
    insert into public.clients (company_id, status, display_name, company_name, email, phone, lead_source)
    values (
      f.company_id, 'lead',
      left(coalesce(nullif(trim(p_name), ''), nullif(trim(p_company_name), ''), v_email, nullif(trim(p_phone), '')), 200),
      nullif(left(trim(p_company_name), 200), ''), v_email, nullif(left(trim(p_phone), 30), ''), 'Website form'
    )
    returning id into v_client;
  end if;

  if v_line1 is not null then
    if v_matched then
      select p.id into v_property from public.properties p
      where p.client_id = v_client and lower(trim(p.line1)) = lower(v_line1)
      order by p.created_at limit 1;
    end if;
    if v_property is null then
      insert into public.properties (company_id, client_id, line1, line2, city, region, postal_code)
      values (
        f.company_id, v_client, left(v_line1, 200), nullif(left(trim(p_address ->> 'line2'), 200), ''),
        nullif(left(trim(p_address ->> 'city'), 100), ''), nullif(left(trim(p_address ->> 'region'), 100), ''), nullif(left(trim(p_address ->> 'postal_code'), 12), '')
      )
      returning id into v_property;
      v_new_property := true;
    end if;
  end if;

  insert into public.requests (company_id, client_id, property_id, website_form_id, source, title, details, answers, web_visit, created_by,
                               promo_code, rejected_promo_code, promo_problem)
  values (
    f.company_id, v_client, v_property, f.id, 'web_form', left(coalesce(nullif(trim(p_title), ''), f.name), 200), nullif(trim(p_details), ''),
    coalesce(p_answers, '{}') || case when v_matched then coalesce(p_contact, '{}') else '{}' end, p_web_visit, null,
    v_code, case when v_code is null then v_promo end, case when v_code is null then v_problem end
  )
  returning * into v_request;

  return jsonb_build_object(
    'request_id', v_request.id, 'number', v_request.number, 'client_id', v_client, 'property_id', v_property,
    'new_property', v_new_property, 'matched', v_matched,
    'promo_code', v_request.promo_code, 'rejected_promo_code', v_request.rejected_promo_code, 'promo_problem', v_request.promo_problem
  );
end $$;

revoke execute on function public.website_form_request(uuid, text, text, text, text, jsonb, text, text, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.website_form_request(uuid, text, text, text, text, jsonb, text, text, jsonb, jsonb, jsonb, text) to service_role;

notify pgrst, 'reload schema';
