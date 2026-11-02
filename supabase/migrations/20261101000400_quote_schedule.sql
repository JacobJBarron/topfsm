-- ---------------------------------------------------------------------------------------------
-- A quote for recurring work says how often
-- ---------------------------------------------------------------------------------------------

-- Weekly mowing is quoted per visit: the quote keeps how often, as a recurring job does (jobs'
-- columns of the same names; null recurrence_rule = one time), so the client reads "Every 2 weeks ·
-- $55.00 per visit", and converting it makes a recurring job billed per visit.
alter table public.quotes
  add column recurrence_rule text,
  add column active_months smallint[],
  add column starts_on date,
  add column ends_on date;

-- As 20261025000100_contracts_and_options.sql, with the schedule carried onto the job. A first visit
-- that went by while the client decided is today, where the business is. The server makes the
-- visits right after (services/sales.ts convertQuote).
create or replace function public.convert_quote_to_job(p_quote uuid) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare q public.quotes; v_job uuid; v_label text; v_today date; v_repeats boolean;
begin
  select * into q from public.quotes where id = p_quote for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if q.status in ('converted', 'lost', 'archived') then
    raise exception 'This quote is already %', q.status using errcode = '22023';
  end if;
  if q.status <> 'approved' and exists (select 1 from public.quote_options where quote_id = q.id) then
    raise exception 'This estimate offers options. Mark it approved with the option they chose first.' using errcode = '22023';
  end if;
  if q.change_order_for is not null then
    return private.apply_change_order(q.id);
  end if;

  v_repeats := q.recurrence_rule is not null;
  select (now() at time zone coalesce(c.timezone, 'UTC'))::date into v_today from public.companies c where c.id = q.company_id;
  insert into public.jobs (company_id, client_id, property_id, quote_id, title, instructions, kind, recurrence_rule, active_months, starts_on, ends_on, billing_mode)
  values (
    q.company_id, q.client_id, q.property_id, q.id, q.title, q.message,
    case when v_repeats then 'recurring' else 'one_off' end,
    q.recurrence_rule,
    case when v_repeats then q.active_months end,
    case when v_repeats then greatest(coalesce(q.starts_on, v_today), v_today) end,
    case when v_repeats then q.ends_on end,
    case when v_repeats then 'per_visit' else 'on_completion' end
  )
  returning id into v_job;

  insert into public.job_line_items (company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort)
  select company_id, v_job, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort
  from public.quote_line_items where quote_id = q.id and selected;
  select coalesce('Promo code ' || p.code, 'Discount') into v_label from public.promo_codes p where p.id = q.promo_code_id;
  perform private.carry_quote_discount(q.id, v_job, coalesce(v_label, 'Discount'));

  update public.quotes set status = 'converted', converted_at = now() where id = q.id;
  if q.request_id is not null then
    update public.requests set status = 'converted' where id = q.request_id;
  end if;
  update public.clients set status = 'active' where id = q.client_id and status = 'lead';
  return v_job;
end $$;

notify pgrst, 'reload schema';
