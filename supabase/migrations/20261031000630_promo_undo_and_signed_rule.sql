-- Follow-ups to promo codes once per job (20261031000600_promo_once_per_job.sql), from checking it in
-- a running instance (docs/marketing-plan.md, "Promo code fixes"):
--
--   * Undo after taking a once-per-job code off a draft. With another draft open, the code moved to it
--     at once, and Undo was then refused because it was there. Now Undo takes it back off the draft it
--     moved to. Only an invoice that can't change any more (sent, or with a payment, or in Stripe)
--     keeps it, and the refusal names that one.
--   * A quote keeps the words it was signed with. quotes.promo_every_visit fixes how its code comes off
--     when the client approves it (or it becomes a job straight away), so a code switched later, or a
--     job switched on its page, doesn't change what an approved quote says. The job made from it
--     takes that rule too.
--   * A code deleted before its quote became a job left a typed discount, which came off every visit.
--     Deleting a code now leaves its rule on the quotes still using it, so the job takes it off as the
--     code said.
--   * One promo code to an invoice: an invoice that has a code's discount line from its job's quote
--     doesn't take a second code on top, and the other way round, the job's line isn't put back on
--     (Undo) an invoice that has a code of its own (place_job_discounts passes one over).

-- ---------------------------------------------------------------------------------------------
-- Undo takes the code back off the draft it moved to
-- ---------------------------------------------------------------------------------------------

-- As in 20261031000600_promo_once_per_job.sql, except that putting a once-per-job line back (Undo)
-- after the code moved to another of the job's drafts takes it back off those drafts, the same part
-- (taxed or not) first, then the newest, so it's on this invoice again and never twice. Only drafts
-- that can still change give it back; when another invoice keeps it, the refusal names that invoice.
-- A discount in two parts comes off as two lines with one skip, which stays until both are back, so
-- the second Undo takes its part back too. A promo line put back or made bigger on an invoice that
-- has a promo code of its own (it took one meanwhile) is refused: one code to an invoice. The
-- discount stays where it went, or waits for the next invoice.
create or replace function private.promo_line_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_key uuid := coalesce(new.discount_quote_id, old.discount_quote_id);
  v_was numeric := 0;
  v_now numeric := 0;
  v_owed numeric;
  v_placed numeric;
  v_here numeric;
  v_over numeric;
  v_take numeric;
  v_setting text;
  s public.job_discount_skips;
  r record;
  v_number bigint;
  v_code text;
begin
  if tg_op = 'UPDATE' and new.discount_quote_id is distinct from old.discount_quote_id then
    raise exception 'A promo code''s line stays linked to its code. Remove the line instead' using errcode = '22023';
  end if;
  if coalesce(current_setting('crewtavo.job_discounts', true), '') = 'on' or v_key is null then
    return coalesce(new, old);
  end if;
  if tg_op <> 'INSERT' then v_was := -round(old.quantity * old.unit_price, 2); end if;
  if tg_op <> 'DELETE' then v_now := -round(new.quantity * new.unit_price, 2); end if;
  if v_now = v_was then
    return coalesce(new, old);
  end if;
  -- The invoice is gone (its lines go with it) or isn't a draft (invoice_lines_guard says so).
  select * into i from public.invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if not found or i.job_id is null or i.status <> 'draft' then
    return coalesce(new, old);
  end if;
  -- One promo code to an invoice: the job's doesn't go on (or grow on) one with its own.
  if v_now > v_was and i.promo_code_id is not null then
    select p.code into v_code from public.promo_codes p where p.id = i.promo_code_id;
    raise exception 'This invoice has promo code %, so % can''t go on it too. Take % off first.', v_code, new.name, v_code
      using errcode = '22023';
  end if;
  -- Every-visit copies come off each visit: there's no once-per-job amount to hold them to.
  if not exists (select 1 from public.job_line_items where job_id = i.job_id and discount_key = v_key and discount_billing = 'once') then
    if v_now < v_was then
      insert into public.job_discount_skips (company_id, invoice_id, discount_key) values (i.company_id, i.id, v_key)
      on conflict do nothing;
    else
      delete from public.job_discount_skips where invoice_id = i.id and discount_key = v_key;
    end if;
    return coalesce(new, old);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('invoice-for-job:' || i.job_id::text, 0));
  select max(x.key_owed), max(x.key_placed) into v_owed, v_placed from private.job_discounts_left(i.job_id) x where x.discount_key = v_key;
  -- What this invoice holds for it now, the row being changed as it was.
  select coalesce(-sum(round(l.quantity * l.unit_price, 2)), 0) into v_here from public.invoice_line_items l where l.invoice_id = i.id and l.discount_quote_id = v_key;
  if v_now < v_was then
    insert into public.job_discount_skips (company_id, invoice_id, discount_key, held, held_elsewhere) values (i.company_id, i.id, v_key, v_here, v_placed - v_here)
    on conflict do nothing;
    return coalesce(new, old);
  end if;
  select * into s from public.job_discount_skips k where k.invoice_id = i.id and k.discount_key = v_key;
  v_over := v_placed + (v_now - v_was) - greatest(v_owed, coalesce(s.held + s.held_elsewhere, 0));
  -- Put back after it came off here and went on another draft: it comes back off that draft.
  if v_over > 0 and s.invoice_id is not null then
    v_setting := coalesce(current_setting('crewtavo.job_discounts', true), '');
    perform set_config('crewtavo.job_discounts', 'on', true);
    for r in
      select il.id, -round(il.quantity * il.unit_price, 2) as held
        from public.invoice_line_items il join public.invoices inv on inv.id = il.invoice_id
       where inv.job_id = i.job_id and inv.id <> i.id and inv.status = 'draft' and inv.kind in ('standard', 'visits')
         and il.discount_quote_id = v_key and il.unit_price < 0
         and private.referral_credits_changeable(inv.id)
       order by il.taxable = new.taxable desc, inv.issued_on desc, inv.number desc nulls first, inv.created_at desc, il.sort desc, il.id desc
    loop
      exit when v_over <= 0;
      v_take := least(r.held, v_over);
      if v_take = r.held then
        delete from public.invoice_line_items where id = r.id;
      else
        update public.invoice_line_items set quantity = 1, unit_price = -(r.held - v_take) where id = r.id;
      end if;
      v_over := v_over - v_take;
    end loop;
    perform set_config('crewtavo.job_discounts', v_setting, true);
  end if;
  if v_over > 0 then
    -- Named only when it went on another invoice after it came off here: the newest that still has it.
    if s.invoice_id is not null and v_placed - v_here > s.held_elsewhere then
      select inv.number into v_number from public.invoice_line_items l join public.invoices inv on inv.id = l.invoice_id
       where inv.job_id = i.job_id and inv.status <> 'void' and l.discount_quote_id = v_key and inv.id <> i.id
       order by inv.created_at desc limit 1;
    end if;
    raise exception '%', case
      when v_number is not null then format('%s went on invoice #%s after it came off here, so it can''t go back on this one.', new.name, v_number)
      else format('That''s more than is left of %s on this job.', new.name) end
      using errcode = '22023';
  end if;
  -- Back to what it held before it came off: the skip goes. Short of it (the other part of a split
  -- discount is still to come back), it stays, with what was held then.
  if s.invoice_id is null or v_here + (v_now - v_was) >= s.held then
    delete from public.job_discount_skips where invoice_id = i.id and discount_key = v_key;
  end if;
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------------------------------
-- How a quote's code comes off, as it was signed
-- ---------------------------------------------------------------------------------------------

alter table public.quotes add column promo_every_visit boolean;
comment on column public.quotes.promo_every_visit is 'How its promo code''s discount comes off recurring work, fixed when the client approved it (or when its code was deleted before it became a job): true every visit, false once. Null: the code''s own setting, or a typed discount.';

-- An open quote follows its code's setting, which can change. Approved (or made a job straight away),
-- it keeps the rule it had then. A quote whose code is gone keeps the rule the code left it (see
-- promo_code_gone below) until the office types a discount of its own or takes it off. Quotes approved
-- before this said nothing about it, and still don't.
create function private.quote_promo_rule() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.promo_code_id is not null then
    if new.status in ('draft', 'sent', 'changes_requested') then
      new.promo_every_visit := null;
    elsif new.status in ('approved', 'converted') and (tg_op = 'INSERT' or old.status not in ('approved', 'converted')) then
      new.promo_every_visit := (select p.every_visit from public.promo_codes p where p.id = new.promo_code_id);
    end if;
  elsif tg_op = 'INSERT' or new.discount_amount is distinct from old.discount_amount then
    new.promo_every_visit := null;
  end if;
  return new;
end $$;
create trigger promo_rule before insert or update of status, promo_code_id, discount_amount on public.quotes
  for each row execute function private.quote_promo_rule();

-- A code deleted: the quotes still using it that aren't jobs yet keep its rule with their discount, so
-- a job made from one later takes it off as the code said, not as a typed discount (every visit).
create function private.promo_code_gone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.quotes set promo_every_visit = old.every_visit
   where promo_code_id = old.id and promo_every_visit is null and status not in ('converted', 'lost', 'archived');
  return old;
end $$;
create trigger keep_rule before delete on public.promo_codes
  for each row execute function private.promo_code_gone();

-- As in 20261031000600_promo_once_per_job.sql, and a promo code's discount follows the rule the quote
-- was approved with (or its code left it), else the code's own.
create or replace function private.carry_quote_discount(p_quote uuid, p_job uuid, p_label text) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_base numeric; v_base_taxable numeric; v_discount numeric; v_taxable_part numeric; v_billing text;
begin
  select * into q from public.quotes where id = p_quote;
  if not found or q.discount_amount <= 0 then
    return;
  end if;
  -- Called from convert_quote_to_job as the user (the backfill in 20261031000600 runs as the owner).
  if auth.uid() is not null and not private.has_role(q.company_id, '{owner,admin,office,estimator}') then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  select coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable and unit_price > 0), 0)
    into v_base, v_base_taxable
  from public.quote_line_items where quote_id = q.id and selected;
  v_discount := least(q.discount_amount, greatest(q.subtotal, 0));
  if v_discount <= 0 or v_base <= 0 then
    return;
  end if;
  -- A typed discount has no code and no rule, and comes off every visit as a plain line.
  v_billing := case
    when coalesce(q.promo_every_visit, (select p.every_visit from public.promo_codes p where p.id = q.promo_code_id)) then 'every_visit'
    when q.promo_every_visit is not null or q.promo_code_id is not null then 'once' end;
  v_taxable_part := round(v_discount * v_base_taxable / v_base, 2);
  if v_taxable_part > 0 then
    insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort, discount_billing, discount_key)
    values (q.company_id, p_job, p_label, 1, 'ea', -v_taxable_part, true, 100000, v_billing, case when v_billing is not null then q.id end);
  end if;
  if v_discount - v_taxable_part > 0 then
    insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort, discount_billing, discount_key)
    values (q.company_id, p_job, p_label, 1, 'ea', -(v_discount - v_taxable_part), false, 100001, v_billing, case when v_billing is not null then q.id end);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- One promo code to an invoice
-- ---------------------------------------------------------------------------------------------

-- As in 20261031000610_promo_bank_payments.sql, and an invoice that has a promo code's discount line
-- (from its job's quote) doesn't take another code on top, as a quote takes one code at a time.
create or replace function public.apply_promo_code(p_kind text, p_id uuid, p_code text, p_option uuid default null, p_selected uuid[] default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes; i public.invoices; p public.promo_codes; v_base numeric; v_option uuid;
begin
  if p_kind = 'quote' then
    select * into q from public.quotes where id = p_id for update;
    if not found then raise exception 'Quote not found' using errcode = 'P0002'; end if;
    if q.status not in ('draft', 'sent', 'changes_requested') then
      raise exception 'Promo codes can''t be added once a quote is approved.' using errcode = '22023';
    end if;
    if p_option is not null and not exists (select 1 from public.quote_options where quote_id = q.id and id = p_option) then
      raise exception 'The options on this estimate changed. Please look it over again.' using errcode = '22023';
    end if;
    -- A price agreed on site already has its discount in it (core sitePriceSet, which the API and the
    -- screens check first): its "Price adjustment" line on what counts, or, without options, the
    -- discount it set. A visit that kept the estimate's price set neither.
    if q.priced_on_site_at is not null and (
         exists (select 1 from public.quote_line_items l
                  where l.quote_id = q.id and l.name = 'Price adjustment' and l.service_id is null and coalesce(l.formula, '') = ''
                    and (l.option_id is null or l.option_id = q.option_id) and (not l.optional or l.selected))
         or (q.option_id is null and q.promo_code_id is null and q.discount_amount > 0)) then
      raise exception 'A price was set on site for this estimate, so a promo code can''t go on it too. Set the price back to the estimate''s first.'
        using errcode = '22023';
    end if;
    v_option := coalesce(p_option, q.option_id);
    -- The lines of an option that isn't shown are all unselected: its required ones count, and its
    -- add-ons only when they're picked.
    select coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0 and case
             when p_selected is not null then not optional or id = any(p_selected)
             when option_id is not null and option_id is distinct from q.option_id then not optional
             else selected end), 0) into v_base
    from public.quote_line_items where quote_id = q.id and (option_id is null or option_id = v_option);
    -- One use of a code at a time, so its limits hold when two documents take it at once.
    perform pg_advisory_xact_lock(hashtextextended('promo:' || q.company_id::text || ':' || upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')), 0));
    p := private.find_promo(q.company_id, q.client_id, p_code, v_base, q.id);
    update public.quotes set promo_code_id = p.id where id = q.id returning * into q;
    return jsonb_build_object('code', p.code, 'description', p.description, 'discount_amount', q.discount_amount, 'total', q.total);
  elsif p_kind = 'invoice' then
    select * into i from public.invoices where id = p_id for update;
    if not found then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
    if i.status not in ('draft', 'sent', 'overdue') or exists (select 1 from public.payments where invoice_id = i.id) then
      raise exception 'Promo codes can only be added before an invoice is paid.' using errcode = '22023';
    end if;
    if private.bank_payment_clearing(i.id) then
      raise exception 'A bank payment for this invoice is on its way, so its promo code can''t change until it clears.' using errcode = '22023';
    end if;
    if exists (select 1 from public.invoice_line_items l where l.invoice_id = i.id and l.discount_quote_id is not null) then
      raise exception 'This invoice already has a promo code''s discount, so another code can''t go on it.' using errcode = '22023';
    end if;
    select coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0), 0) into v_base
    from public.invoice_line_items where invoice_id = i.id;
    -- One use of a code at a time, so its limits hold when two documents take it at once.
    perform pg_advisory_xact_lock(hashtextextended('promo:' || i.company_id::text || ':' || upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')), 0));
    p := private.find_promo(i.company_id, i.client_id, p_code, v_base, i.id);
    update public.invoices set promo_code_id = p.id where id = i.id returning * into i;
    return jsonb_build_object('code', p.code, 'description', p.description, 'discount_amount', i.discount_amount, 'total', i.total);
  end if;
  raise exception 'Unknown document type' using errcode = '22023';
end $$;

revoke all on function private.quote_promo_rule(), private.promo_code_gone() from public;

notify pgrst, 'reload schema';
