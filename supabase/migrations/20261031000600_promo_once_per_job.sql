-- A promo code comes off once per job (docs/marketing-plan.md, "Promo code fixes"). A code on a quote
-- became negative "Promo code X" job lines, and create_invoice_for_job copied every job line onto
-- every invoice made from the job: on weekly mowing a $25 code came off every mowing, and a code worth
-- the visit made every visit $0. Now:
--
--   promo_codes.every_visit          off (the default): the code comes off a job's first invoice.
--                                    On: it comes off every visit's invoice, as before.
--   job_line_items.discount_billing  'once' or 'every_visit' on a promo code's discount lines (null
--   job_line_items.discount_key      on every other line), and the quote whose discount they are (the
--                                    job's own, or a change order's). The key has no foreign key: it
--                                    outlives the quote, and a change order approved again keeps it.
--   invoice_line_items.discount_quote_id  the key on an invoice's promo lines, so what a job's discount
--                                    already took off is counted (private.job_discounts_left).
--   job_discount_skips               drafts someone took a job's discount off: it goes on the job's
--                                    next invoice, never back on that one by itself.
--
-- Where a once-per-job discount goes (private.place_job_discounts): the job's oldest open draft that
-- isn't a deposit, progress or retainage invoice, with no payments, nothing in Stripe and no promo
-- code of its own (one code to an invoice), else the next invoice made from the job. Never more than that invoice's lines come to, so a discount never takes an
-- invoice below $0; what doesn't fit waits for the next one. A draft voided or deleted gives it back
-- (job_discounts_void, job_discounts_deleted), and so does a line made smaller or taken off a draft
-- (promo_line_fit). Sent invoices keep their lines (invoice_lines_guard). What's left is counted for
-- the whole discount, taxed and untaxed parts together, so changing a line's Taxable box never owes it
-- again. Every-visit copies are cut back while a draft's lines come to less than $0, down to a $0 line
-- that stays (private.fit_job_discounts), and grow back to the visit's amount as the draft's charges
-- do, unless someone took them off by hand.
--
-- Codes already on jobs are once per job now (private.backfill_job_discounts): a recurring job that
-- already took its code off an invoice doesn't take it again, invoices already made keep what they
-- have, and a draft someone took the code off before keeps it off. Typed discounts ("Discount") still
-- come off every visit.

alter table public.promo_codes add column every_visit boolean not null default false;
comment on column public.promo_codes.every_visit is 'Off: the code comes off the first invoice of a job. On: it comes off every visit''s invoice of recurring work.';

alter table public.job_line_items
  add column discount_billing text check (discount_billing in ('once', 'every_visit')),
  add column discount_key uuid,
  -- Only a promo code's discount, which takes money off, is held back from invoices.
  add constraint job_line_items_discount_check
    check ((discount_billing is null) = (discount_key is null) and (discount_billing is null or (unit_price < 0 and quantity > 0)));
comment on column public.job_line_items.discount_billing is 'A promo code''s discount line: once (it comes off the job''s first invoice) or every_visit (it comes off every visit''s invoice). Null on other lines.';
comment on column public.job_line_items.discount_key is 'The quote (the job''s, or a change order''s) whose promo discount this is. No foreign key: it outlives the quote.';
create index job_line_items_discount_idx on public.job_line_items (job_id) where discount_key is not null;

alter table public.invoice_line_items
  add column discount_quote_id uuid,
  add constraint invoice_line_items_discount_check check (discount_quote_id is null or unit_price <= 0);
comment on column public.invoice_line_items.discount_quote_id is 'On a promo code''s discount line: the job line''s discount_key, so the job knows what its discount already took off.';
create index invoice_line_items_discount_idx on public.invoice_line_items (discount_quote_id) where discount_quote_id is not null;

create table public.job_discount_skips (
  company_id uuid not null references public.companies (id) on delete cascade,
  invoice_id uuid not null,
  discount_key uuid not null,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  -- What this invoice and the job's others took off for the discount just before it came off here, so
  -- Undo can put back what was there without letting it come off twice, and say where it went.
  held numeric(12,2) not null default 0,
  held_elsewhere numeric(12,2) not null default 0,
  primary key (invoice_id, discount_key),
  foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete cascade
);
comment on table public.job_discount_skips is 'Drafts someone took a job''s promo discount off: it goes on the job''s next invoice instead.';
comment on column public.job_discount_skips.held is 'What this invoice took off for the discount just before it came off (Undo can put that back).';
comment on column public.job_discount_skips.held_elsewhere is 'What the job''s other invoices took off for it then: more now means it went on one of them.';
alter table public.job_discount_skips enable row level security;
create policy job_discount_skips_read on public.job_discount_skips for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'invoices'));
revoke insert, update, delete on public.job_discount_skips from authenticated;

-- ---------------------------------------------------------------------------------------------
-- A quote's discount on its job
-- ---------------------------------------------------------------------------------------------

-- As in 20261017001500_billing_fixes.sql, and a promo code's lines say how they come off (the code's
-- every_visit) and whose they are (the quote). convert_quote_to_job and apply_change_order call it.
create or replace function private.carry_quote_discount(p_quote uuid, p_job uuid, p_label text) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_base numeric; v_base_taxable numeric; v_discount numeric; v_taxable_part numeric; v_billing text;
begin
  select * into q from public.quotes where id = p_quote;
  if not found or q.discount_amount <= 0 then
    return;
  end if;
  -- Called from convert_quote_to_job as the user (the backfill below runs as the owner).
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
  -- A typed discount (or a code deleted before the quote became a job) has no code to follow.
  select case when p.every_visit then 'every_visit' else 'once' end into v_billing from public.promo_codes p where p.id = q.promo_code_id;
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
revoke execute on function private.carry_quote_discount(uuid, uuid, text) from public;
grant execute on function private.carry_quote_discount(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- What a job's once-per-job discounts still have to take off, and where it goes
-- ---------------------------------------------------------------------------------------------

-- Each once-per-job discount of the job, by key and by its taxed and untaxed parts: what the job's
-- lines take off (owed) and what the job's invoices that aren't void already take off for it
-- (placed), and the same for the whole discount (key_owed, key_placed). What's still to go on
-- invoices (due) is counted for the whole discount, so a Taxable box changed on a discount line, on
-- the job or on an invoice, never makes it owed again: each part is due what it's short of, the taxed
-- part first, up to what the discount as a whole still has to take off.
create function private.job_discounts_left(p_job uuid)
returns table (discount_key uuid, taxable boolean, name text, sort integer, owed numeric, placed numeric, due numeric, key_owed numeric, key_placed numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.jobs where id = p_job;
  if not found then return; end if;
  if auth.uid() is not null and not (private.has_role(v_company, '{owner,admin,office}') and private.has_perm(v_company, 'invoices')) then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  return query
    with parts as (
      select l.discount_key as k, l.taxable as t, min(l.name) as n, min(l.sort) as s, -sum(round(l.quantity * l.unit_price, 2)) as o
        from public.job_line_items l
       where l.job_id = p_job and l.discount_billing = 'once'
       group by l.discount_key, l.taxable
    ),
    held as (
      select il.discount_quote_id as k, il.taxable as t, -sum(round(il.quantity * il.unit_price, 2)) as p
        from public.invoice_line_items il join public.invoices i on i.id = il.invoice_id
       where i.job_id = p_job and i.status <> 'void' and il.discount_quote_id in (select parts.k from parts)
       group by il.discount_quote_id, il.taxable
    ),
    sums as (
      select parts.k, parts.t, parts.n, parts.s, parts.o, coalesce(h.p, 0) as p,
             greatest(parts.o - coalesce(h.p, 0), 0) as gap,
             sum(parts.o) over (partition by parts.k) as ko,
             (select coalesce(sum(h2.p), 0) from held h2 where h2.k = parts.k) as kp
        from parts left join held h on h.k = parts.k and h.t = parts.t
    )
    select sums.k, sums.t, sums.n, sums.s, sums.o, sums.p,
           greatest(least(sums.gap, greatest(sums.ko - sums.kp, 0)
                    - coalesce(sum(sums.gap) over (partition by sums.k order by sums.t desc rows between unbounded preceding and 1 preceding), 0)), 0),
           sums.ko, sums.kp
      from sums;
end $$;

-- Puts what's due of the job's once-per-job discounts on its invoices, the taxed part first: the
-- oldest open draft that can take it (a standard or visits invoice with no payments, nothing in
-- Stripe and no promo code of its own, which nobody took it off), up to what its lines come to, so it
-- never goes below $0. What doesn't fit waits for the next invoice. Every-visit copies a draft had no
-- room for grow back first, each to the job's amount for a visit, as room comes back. Says how much
-- once-per-job discount went on. The caller holds the job's invoice-for-job lock; while it runs, the
-- line triggers leave the lines it writes alone. A draft taking a code at the same time is locked
-- (apply_promo_code), so it's passed over, and the code then sees the line if it went on first.
create function private.place_job_discounts(p_job uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  d record;
  c record;
  inv record;
  v_left numeric;
  v_room numeric;
  v_put numeric;
  v_total numeric := 0;
  v_was text := coalesce(current_setting('crewtavo.job_discounts', true), '');
begin
  select * into j from public.jobs where id = p_job;
  if not found then return 0; end if;
  if auth.uid() is not null and not (private.has_role(j.company_id, '{owner,admin,office}') and private.has_perm(j.company_id, 'invoices')) then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  perform set_config('crewtavo.job_discounts', 'on', true);
  -- Every-visit copies fit_job_discounts cut back (to $0 at most, the line stays): back up to the job's
  -- amount for each visit, as far as the draft's lines leave room. Not on a draft someone took it off
  -- or cut it by hand (a skip), nor one with payments, in Stripe or with a code of its own. A part has
  -- one line on the job.
  for c in
    select il.id, il.invoice_id, round(il.quantity * il.unit_price, 2) as amount,
           (select -sum(round(l.quantity * l.unit_price, 2)) from public.job_line_items l
             where l.job_id = p_job and l.discount_key = il.discount_quote_id and l.discount_billing = 'every_visit' and l.taxable = il.taxable) as full_amount
      from public.invoice_line_items il join public.invoices i on i.id = il.invoice_id
     where i.job_id = p_job and i.kind in ('standard', 'visits') and i.status = 'draft' and il.discount_quote_id is not null
       and i.promo_code_id is null and private.referral_credits_changeable(i.id)
       and not exists (select 1 from public.job_discount_skips s where s.invoice_id = i.id and s.discount_key = il.discount_quote_id)
     order by i.issued_on, i.number nulls last, i.created_at, il.sort, il.id
     for update of i skip locked
  loop
    continue when c.full_amount is null or -c.amount >= c.full_amount;
    select greatest(coalesce(sum(round(quantity * unit_price, 2)), 0), 0) into v_room from public.invoice_line_items where invoice_id = c.invoice_id;
    v_put := least(c.full_amount + c.amount, v_room);
    continue when v_put <= 0;
    update public.invoice_line_items set quantity = 1, unit_price = c.amount - v_put where id = c.id;
  end loop;
  for d in
    select * from private.job_discounts_left(p_job) x where x.due > 0 order by x.sort, x.discount_key, x.taxable desc
  loop
    v_left := d.due;
    for inv in
      select i.id, i.kind from public.invoices i
       where i.job_id = p_job and i.kind in ('standard', 'visits') and i.status = 'draft' and i.promo_code_id is null
         and private.referral_credits_changeable(i.id)
         and not exists (select 1 from public.job_discount_skips s where s.invoice_id = i.id and s.discount_key = d.discount_key)
       order by i.issued_on, i.number nulls last, i.created_at
       for update of i skip locked
    loop
      exit when v_left <= 0;
      select greatest(coalesce(sum(round(quantity * unit_price, 2)), 0), 0) into v_room from public.invoice_line_items where invoice_id = inv.id;
      continue when v_room <= 0;
      v_put := least(v_left, v_room);
      -- Onto its line for this discount when it has one already, else a line of its own: on a standard
      -- invoice where the job has it, and after every visit on a visits invoice.
      update public.invoice_line_items set unit_price = unit_price - v_put
       where id = (select l.id from public.invoice_line_items l
                    where l.invoice_id = inv.id and l.discount_quote_id = d.discount_key and l.taxable = d.taxable and l.quantity = 1
                    order by l.sort limit 1);
      if not found then
        insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id)
        values (j.company_id, inv.id, d.name, 1, 'ea', -v_put, d.taxable,
                case when inv.kind = 'visits' then (select coalesce(max(sort), 0) + 1 from public.invoice_line_items where invoice_id = inv.id) else d.sort end,
                d.discount_key);
      end if;
      v_left := v_left - v_put;
      v_total := v_total + v_put;
    end loop;
  end loop;
  perform set_config('crewtavo.job_discounts', v_was, true);
  return v_total;
end $$;

-- While a draft's lines come to less than $0, its promo lines are cut back, the last first: an
-- every-visit copy on a visit whose price was lowered, or a discount whose lines were edited since.
-- A deposit or progress credit is never touched. What a once-per-job discount gives up goes on the
-- job's next invoice (the caller places it). An every-visit copy stays on its visit at $0 at most, so
-- it grows back when the draft's charges do (an Undo, a price raised again) rather than being lost.
create function private.fit_job_discounts(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_over numeric;
  l record;
  v_was text := coalesce(current_setting('crewtavo.job_discounts', true), '');
begin
  select * into i from public.invoices where id = p_invoice;
  if not found or i.status <> 'draft' then return; end if;
  if auth.uid() is not null and not (private.has_role(i.company_id, '{owner,admin,office}') and private.has_perm(i.company_id, 'invoices')) then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  perform set_config('crewtavo.job_discounts', 'on', true);
  loop
    select -coalesce(sum(round(quantity * unit_price, 2)), 0) into v_over from public.invoice_line_items where invoice_id = p_invoice;
    exit when v_over <= 0;
    select il.id, round(il.quantity * il.unit_price, 2) as amount,
           exists (select 1 from public.job_line_items jl
                    where jl.job_id = i.job_id and jl.discount_key = il.discount_quote_id and jl.discount_billing = 'every_visit') as every_visit
      into l from public.invoice_line_items il
     where il.invoice_id = p_invoice and il.discount_quote_id is not null and il.unit_price < 0
     order by il.sort desc, il.id desc limit 1;
    exit when l.id is null;
    if -l.amount <= v_over and l.every_visit then
      update public.invoice_line_items set quantity = 1, unit_price = 0 where id = l.id;
    elsif -l.amount <= v_over then
      delete from public.invoice_line_items where id = l.id;
    else
      update public.invoice_line_items set quantity = 1, unit_price = l.amount + v_over where id = l.id;
    end if;
  end loop;
  perform set_config('crewtavo.job_discounts', v_was, true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Invoicing a job
-- ---------------------------------------------------------------------------------------------

-- As in 20261019001000_tax_rate_precision.sql, except that a once-per-job promo discount isn't copied
-- from the job's lines: it's placed after the lines go in (place_job_discounts), on a standard or
-- visits invoice only. Deposits, progress billing and retainage never take it: it's in the contract
-- total those bill parts of. Every-visit copies keep their key, and are cut back so the invoice
-- doesn't go below $0 (fit_job_discounts).
create or replace function public.create_invoice_for_job(p_job uuid, p_kind text default 'standard', p_amount numeric default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  j public.jobs;
  v_invoice uuid;
  v_terms integer;
  v_tax numeric;
  v_today date;
  v_deposit numeric;
  v_amount numeric;
  v_contract numeric;
  v_prebilled numeric;
  v_existing bigint;
  v_sort integer := 0;
  v_was text := coalesce(current_setting('crewtavo.job_discounts', true), '');
  r record;
begin
  -- One invoice at a time for a job, so the checks below see each other's invoices.
  perform pg_advisory_xact_lock(hashtextextended('invoice-for-job:' || p_job::text, 0));
  select * into j from public.jobs where id = p_job;
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  if p_kind not in ('standard', 'deposit', 'progress', 'visits', 'retainage') then
    raise exception 'Unknown invoice type' using errcode = '22023';
  end if;
  select contract_total into v_contract from public.job_financials where job_id = j.id;
  select coalesce((settings ->> 'payment_terms_days')::integer, 30), coalesce((settings ->> 'default_tax_rate')::numeric, 0),
         (now() at time zone coalesce(timezone, 'UTC'))::date
    into v_terms, v_tax, v_today
  from public.companies where id = j.company_id;
  -- The rate the client approved on the quote wins over the company default, which a job without
  -- a quote keeps.
  v_tax := coalesce((select q.tax_rate from public.quotes q where q.id = j.quote_id), v_tax, 0);

  select coalesce(sum(subtotal), 0) into v_prebilled
  from public.invoices where job_id = j.id and kind in ('deposit', 'progress') and status <> 'void';

  if p_kind = 'standard' and j.kind <> 'recurring' then
    select number into v_existing from public.invoices
    where job_id = j.id and kind = 'standard' and status <> 'void' order by number limit 1;
    if found then
      raise exception 'This job already has its final invoice (#%). Void it first to bill the job again', v_existing using errcode = '22023';
    end if;
  end if;

  if p_kind = 'visits' and not exists (
    select 1 from public.visits where job_id = j.id and status = 'completed' and invoice_id is null and kind = 'job'
  ) then
    raise exception 'There are no completed visits waiting to be invoiced' using errcode = '22023';
  end if;

  if p_kind = 'deposit' then
    select deposit_amount into v_deposit from public.quotes where id = j.quote_id;
    v_amount := round(coalesce(p_amount, nullif(v_deposit, 0)), 2);
    if v_amount is null or v_amount <= 0 then
      raise exception 'Enter the deposit amount' using errcode = '22023';
    end if;
  elsif p_kind = 'progress' then
    if p_amount is null or p_amount <= 0 then
      raise exception 'Enter how much to bill' using errcode = '22023';
    end if;
    v_amount := round(p_amount, 2);
  elsif p_kind = 'retainage' then
    select coalesce(sum(retainage_amount), 0) into v_amount
    from public.invoices where job_id = j.id and kind <> 'retainage' and status <> 'void';
    v_amount := v_amount - coalesce((select sum(subtotal) from public.invoices where job_id = j.id and kind = 'retainage' and status <> 'void'), 0);
    if v_amount <= 0 then
      raise exception 'There''s no retainage left to bill on this job' using errcode = '22023';
    end if;
  end if;

  if p_kind in ('deposit', 'progress') and j.kind <> 'recurring' and v_prebilled + v_amount > coalesce(v_contract, 0) + 0.005 then
    raise exception 'That''s more than what''s left to bill on this job (%)',
      to_char(greatest(coalesce(v_contract, 0) - v_prebilled, 0), 'FM$999,999,990.00') using errcode = '22023';
  end if;

  insert into public.invoices (company_id, client_id, job_id, kind, subject, issued_on, due_on, tax_rate, retainage_pct, pay_app_number)
  values (
    j.company_id, j.client_id, j.id, p_kind,
    case p_kind when 'deposit' then 'Deposit: ' || j.title when 'visits' then j.title || ' (completed visits)'
                when 'retainage' then 'Retainage: ' || j.title else j.title end,
    v_today, v_today + v_terms,
    case when p_kind in ('deposit', 'retainage') then 0 else v_tax end,
    case when p_kind in ('standard', 'progress') then j.retainage_pct else 0 end,
    case when p_kind = 'progress' then (select coalesce(max(pay_app_number), 0) + 1 from public.invoices where job_id = j.id) end
  )
  returning id into v_invoice;

  -- All the lines go in first; the promo discounts are placed once they're there.
  perform set_config('crewtavo.job_discounts', 'on', true);

  if p_kind = 'deposit' then
    insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Deposit for ' || j.title, 1, 'ea', v_amount, false, 0);

  elsif p_kind = 'retainage' then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Retainage release: ' || j.title, 'Amount held back on earlier invoices for this job', 1, 'ea', v_amount, false, 0);

  elsif p_kind = 'progress' then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Progress billing: ' || j.title,
            case when v_contract > 0 then round(v_amount / v_contract * 100, 1) || '% of the ' || to_char(v_contract, 'FM$999,999,990.00') || ' contract' end,
            1, 'ea', v_amount, true, 0);

  elsif p_kind = 'visits' then
    for r in
      select v.id, coalesce(v.completed_at::date, v.scheduled_on) as day
      from public.visits v
      where v.job_id = j.id and v.status = 'completed' and v.invoice_id is null and v.kind = 'job'
      order by coalesce(v.completed_at::date, v.scheduled_on)
    loop
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort, discount_quote_id)
      select j.company_id, v_invoice, li.name, 'Visit on ' || to_char(r.day, 'Mon DD, YYYY'), li.quantity, li.unit, li.unit_price, li.taxable, v_sort + li.sort, li.discount_key
      from public.job_line_items li where li.job_id = j.id and li.discount_billing is distinct from 'once';
      update public.visits set invoice_id = v_invoice where id = r.id;
      v_sort := v_sort + 1000000;
    end loop;

  else
    insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_quote_id)
    select company_id, v_invoice, service_id, name, description, quantity, unit, unit_price, taxable, sort, discount_key
    from public.job_line_items where job_id = j.id and discount_billing is distinct from 'once';
    -- Credit what was already billed as deposits and progress payments.
    insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
    select j.company_id, v_invoice,
           case i.kind when 'deposit' then 'Less deposit (invoice #' || i.number || ')' else 'Less progress billing (invoice #' || i.number || ')' end,
           -- Progress invoices were taxed, so their credit reduces the taxable amount too.
           1, 'ea', -i.subtotal, i.kind = 'progress', 200000 + row_number() over (order by i.number)
    from public.invoices i
    where i.job_id = j.id and i.kind in ('deposit', 'progress') and i.status <> 'void' and i.id <> v_invoice;
  end if;

  if p_kind in ('standard', 'visits') then
    perform private.place_job_discounts(j.id);
    perform private.fit_job_discounts(v_invoice);
  end if;
  perform set_config('crewtavo.job_discounts', v_was, true);

  -- Touch the invoice so totals include the lines just added.
  update public.invoices set updated_at = now() where id = v_invoice;

  if j.status = 'requires_invoicing' and p_kind in ('standard', 'visits') then
    update public.jobs set status = 'completed' where id = j.id;
  end if;
  return v_invoice;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Following a draft's changes
-- ---------------------------------------------------------------------------------------------

-- Someone changing a promo line by hand (not the functions above):
--   * taken off a draft, or made smaller: the rest goes on the job's next invoice, never back on this
--     one by itself (job_discount_skips, with what this invoice and the others held just before);
--   * put back (Undo) or made bigger: only as far as the job's invoices held it before it came off
--     here, and never more than the job's discount otherwise, or it would come off twice. A job from
--     before codes were once per job may hold it on several invoices, and Undo puts back what was
--     there. Refused because it went on another invoice since, the message names that one. Putting
--     it back lifts the skip.
-- Its Taxable box can change: what's left is counted for the whole discount (job_discounts_left). A
-- line stays linked to its discount, and Duplicate isn't offered on one.
create function private.promo_line_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_key uuid := coalesce(new.discount_quote_id, old.discount_quote_id);
  v_was numeric := 0;
  v_now numeric := 0;
  v_owed numeric;
  v_placed numeric;
  v_here numeric;
  s public.job_discount_skips;
  v_number bigint;
  v_status text;
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
  if v_placed + (v_now - v_was) > greatest(v_owed, coalesce(s.held + s.held_elsewhere, 0)) then
    -- Named only when it went on another invoice after it came off here: the newest that has it.
    if v_placed - v_here > s.held_elsewhere then
      select inv.number, inv.status into v_number, v_status from public.invoice_line_items l join public.invoices inv on inv.id = l.invoice_id
       where inv.job_id = i.job_id and inv.status <> 'void' and l.discount_quote_id = v_key and inv.id <> i.id
       order by inv.status = 'draft' desc, inv.created_at desc limit 1;
    end if;
    raise exception '%', case
      when v_number is not null and v_status = 'draft' then format('%s went on invoice #%s after it came off here. Take it off there first.', new.name, v_number)
      when v_number is not null then format('%s went on invoice #%s after it came off here, so it can''t go back on this one.', new.name, v_number)
      else format('That''s more than is left of %s on this job.', new.name) end
      using errcode = '22023';
  end if;
  delete from public.job_discount_skips where invoice_id = i.id and discount_key = v_key;
  return coalesce(new, old);
end $$;
create trigger promo_line_guard before insert or update or delete on public.invoice_line_items
  for each row execute function private.promo_line_guard();

-- After a draft's lines change by hand: its promo lines fit it (never below $0), and what a
-- once-per-job discount gave up goes on the job's next invoice. Trouble here never fails the change.
-- Row triggers after a statement, not at commit: the functions mark the lines they write, so those
-- don't set it off again.
create function private.promo_line_fit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.invoices;
begin
  if coalesce(current_setting('crewtavo.job_discounts', true), '') = 'on' then return null; end if;
  select * into i from public.invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if not found or i.job_id is null or i.status <> 'draft' or i.kind not in ('standard', 'visits') then return null; end if;
  if not exists (select 1 from public.job_line_items where job_id = i.job_id and discount_key is not null) then return null; end if;
  begin
    perform pg_advisory_xact_lock(hashtextextended('invoice-for-job:' || i.job_id::text, 0));
    perform private.fit_job_discounts(i.id);
    perform private.place_job_discounts(i.job_id);
  exception when others then
    raise warning 'Promo discounts on invoice % weren''t brought up to date: %', i.id, sqlerrm;
  end;
  return null;
end $$;
create trigger promo_line_fit after insert or update or delete on public.invoice_line_items
  for each row execute function private.promo_line_fit();

-- At commit, when one of a job's invoices is voided or deleted: what it took off for a once-per-job
-- discount goes on the job's next invoice (a void invoice keeps its figures, but doesn't hold the
-- discount anymore). At commit, so a deleted invoice's lines are gone by then. The job's lock comes
-- first, then (referral credits at commit) the client's, as when an invoice is made.
create function private.job_discounts_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.job_line_items where job_id = old.job_id and discount_billing = 'once') then return null; end if;
  begin
    perform pg_advisory_xact_lock(hashtextextended('invoice-for-job:' || old.job_id::text, 0));
    perform private.place_job_discounts(old.job_id);
  exception when others then
    raise warning 'Promo discounts on job % weren''t moved to another invoice: %', old.job_id, sqlerrm;
  end;
  return null;
end $$;
-- Two triggers, each queued only when there's something to do: a trigger on delete can't look at NEW.
create constraint trigger job_discounts_void after update on public.invoices deferrable initially deferred
  for each row when (old.job_id is not null and new.status = 'void' and old.status <> 'void')
  execute function private.job_discounts_follow();
create constraint trigger job_discounts_deleted after delete on public.invoices deferrable initially deferred
  for each row when (old.job_id is not null)
  execute function private.job_discounts_follow();

-- A draft deleted takes its referral credits with it at once, and taking one off locks the client
-- (referral_credit_changed): the job's lock comes first here too, before the credits go.
create function private.job_discounts_delete_lock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.job_line_items where job_id = old.job_id and discount_billing = 'once') then
    perform pg_advisory_xact_lock(hashtextextended('invoice-for-job:' || old.job_id::text, 0));
  end if;
  return old;
end $$;
create trigger job_discounts_delete_lock before delete on public.invoices
  for each row when (old.job_id is not null)
  execute function private.job_discounts_delete_lock();

-- ---------------------------------------------------------------------------------------------
-- For the screens
-- ---------------------------------------------------------------------------------------------

-- A job's promo code discounts, for the job page: each discount's name, how it comes off (once or
-- every_visit), the amount, and for the office with the Invoices area what's on invoices already,
-- what's still to go and on which invoices. Others who see the job's prices get nulls there, not
-- "not on an invoice yet"; crews and subs get nothing.
create function public.job_promo_discounts(p_job uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare j public.jobs; v_sees boolean;
begin
  select * into j from public.jobs where id = p_job;
  if not found or not private.has_role(j.company_id, '{owner,admin,office,estimator}') then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  v_sees := private.has_role(j.company_id, '{owner,admin,office}') and private.has_perm(j.company_id, 'invoices');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'key', k.discount_key, 'name', k.name, 'billing', k.billing, 'amount', k.amount,
             'placed', case when v_sees then coalesce(p.placed, 0) end,
             'left', case when v_sees and k.billing = 'once' then greatest(k.amount - coalesce(p.placed, 0), 0) end,
             'invoices', case when v_sees and k.billing = 'once' then coalesce(p.invoices, '[]'::jsonb) end)
           order by k.sort, k.discount_key)
      from (select l.discount_key, min(l.name) as name, min(l.discount_billing) as billing, min(l.sort) as sort,
                   -sum(round(l.quantity * l.unit_price, 2)) as amount
              from public.job_line_items l where l.job_id = j.id and l.discount_key is not null
             group by l.discount_key) k
      left join lateral (
        select sum(x.amount) as placed, jsonb_agg(jsonb_build_object('id', x.id, 'number', x.number, 'amount', x.amount) order by x.number) as invoices
          from (select i.id, i.number, -sum(round(il.quantity * il.unit_price, 2)) as amount
                  from public.invoice_line_items il join public.invoices i on i.id = il.invoice_id
                 where v_sees and i.job_id = j.id and i.status <> 'void' and il.discount_quote_id = k.discount_key
                 group by i.id, i.number) x
      ) p on true
  ), '[]'::jsonb);
end $$;

-- The job page's switch: one of a job's discounts comes off every visit, or the first invoice only,
-- from the next invoice on. Changes only that discount's lines, for people who sell. Says how many
-- changed.
create function public.set_job_discount_billing(p_job uuid, p_key uuid, p_every_visit boolean) returns integer
language plpgsql security invoker set search_path = '' as $$
declare v_company uuid; v_count integer;
begin
  select company_id into v_company from public.jobs where id = p_job;
  if v_company is null or not (private.has_role(v_company, '{owner,admin,office,estimator}') and private.has_perm(v_company, 'sales')) then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  update public.job_line_items set discount_billing = case when p_every_visit then 'every_visit' else 'once' end
   where job_id = p_job and discount_key = p_key
     and discount_billing is distinct from case when p_every_visit then 'every_visit' else 'once' end;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Jobs that aren't closed or archived using a code's discount another way than p_every_visit says,
-- for Marketing → Promo codes when its switch changes: how many, and changing them. For the office
-- with the Marketing area, who change codes.
create function private.promo_code_company(p_promo uuid) returns uuid
language plpgsql stable security invoker set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.promo_codes where id = p_promo;
  if v_company is null or not (private.has_role(v_company, '{owner,admin,office}') and private.has_perm(v_company, 'marketing')) then
    raise exception 'Promo code not found' using errcode = 'P0002';
  end if;
  return v_company;
end $$;

create function public.promo_code_jobs(p_promo uuid, p_every_visit boolean) returns integer
language plpgsql stable security invoker set search_path = '' as $$
begin
  perform private.promo_code_company(p_promo);
  return (select count(distinct l.job_id)::integer
            from public.job_line_items l
            join public.jobs j on j.id = l.job_id
            join public.quotes q on q.id = l.discount_key
           where q.promo_code_id = p_promo and j.status in ('active', 'requires_invoicing')
             and l.discount_billing is distinct from case when p_every_visit then 'every_visit' else 'once' end);
end $$;

create function public.set_promo_code_jobs(p_promo uuid, p_every_visit boolean) returns integer
language plpgsql security invoker set search_path = '' as $$
declare v_jobs integer;
begin
  perform private.promo_code_company(p_promo);
  with changed as (
    update public.job_line_items l set discount_billing = case when p_every_visit then 'every_visit' else 'once' end
      from public.jobs j, public.quotes q
     where j.id = l.job_id and q.id = l.discount_key and q.promo_code_id = p_promo and j.status in ('active', 'requires_invoicing')
       and l.discount_billing is distinct from case when p_every_visit then 'every_visit' else 'once' end
    returning l.job_id
  )
  select count(distinct job_id)::integer into v_jobs from changed;
  return v_jobs;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Codes already on jobs: once per job
-- ---------------------------------------------------------------------------------------------

-- Promo discount lines on jobs made before this are marked once per job, and the invoice lines they
-- were copied to are linked to them, so a recurring job that already took its code off stops taking
-- it, one with no invoices yet takes it once, and one whose only holder is void takes it on its next
-- invoice. A line is the job's own promo discount (no service, one of it, money off, named "Promo code
-- ..."), or a change order's ("Change order discount" from a change order with a code). Not by its
-- sort number: moving any line up or down numbers a job's lines again. A job whose quote is gone uses
-- its own id as the key. Invoice lines are matched by name, part (taxed or not) and price, one to
-- each discount in turn when two look alike; the job's other discounts of the same name (a change
-- order's typed discount) take their turn too, and their copies stay plain. A price changed on a
-- draft is matched by name and part, and a Taxable box changed since (on the draft, or on the job's
-- line) by name alone, only when that's one discount's and no typed discount of that name has the
-- line's part or price (the line could be its copy). Nothing an invoice adds up to changes, nor when
-- it was last changed. An invoice that holds less of a discount than the job's line (the old
-- create_invoice_for_job put it on every one, so someone took it off or cut it) keeps it that way:
-- it's skipped, as if taken off by hand. Says how many job lines it marked.
create function private.backfill_job_discounts() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_jobs uuid[]; v_more uuid[];
begin
  alter table public.job_line_items disable trigger touch_job;
  with marked as (
    update public.job_line_items l set discount_billing = 'once', discount_key = coalesce(j.quote_id, j.id)
      from public.jobs j
     where j.id = l.job_id and l.discount_billing is null and l.service_id is null and l.quantity = 1 and l.unit_price < 0
       and l.source_quote_id is null and l.name like 'Promo code %'
    returning l.job_id
  )
  select coalesce(array_agg(job_id), '{}') into v_jobs from marked;
  with marked as (
    update public.job_line_items l set discount_billing = 'once', discount_key = l.source_quote_id
      from public.quotes q
     where q.id = l.source_quote_id and q.promo_code_id is not null
       and l.discount_billing is null and l.service_id is null and l.quantity = 1 and l.unit_price < 0 and l.name = 'Change order discount'
    returning l.job_id
  )
  select coalesce(array_agg(job_id), '{}') into v_more from marked;
  alter table public.job_line_items enable trigger touch_job;

  alter table public.invoice_line_items disable trigger lines_guard;
  alter table public.invoice_line_items disable trigger touch_invoice;
  alter table public.invoice_line_items disable trigger promo_line_guard;
  alter table public.invoice_line_items disable trigger promo_line_fit;
  with lines as (
    select distinct on (l.job_id, l.discount_key, l.taxable) l.job_id, l.discount_key, l.name, l.taxable, l.unit_price, l.sort
      from public.job_line_items l
     where l.discount_billing = 'once'
     order by l.job_id, l.discount_key, l.taxable, l.sort
  ),
  named as (
    select x.job_id, x.discount_key, x.name, x.taxable, x.unit_price, x.sort from lines x
    union all
    select u.job_id, null, u.name, u.taxable, u.unit_price, u.sort
      from public.job_line_items u
     where u.discount_billing is null and u.unit_price < 0
       and exists (select 1 from lines m where m.job_id = u.job_id and m.name = u.name and m.taxable = u.taxable)
  ),
  marked as (
    select x.*, row_number() over (partition by x.job_id, x.name, x.taxable, x.unit_price order by x.sort, x.discount_key nulls last) as rn,
           count(*) over (partition by x.job_id, x.name, x.taxable, x.unit_price) as alike
      from named x
  ),
  candidates as (
    -- typed: the job has a typed discount this line could be a copy of, its price or its Taxable box
    -- changed since (one of the two still the same).
    select il.id, i.job_id, il.name, il.taxable, il.unit_price,
           row_number() over (partition by il.invoice_id, il.name, il.taxable, il.unit_price order by il.sort, il.id) as nth,
           exists (select 1 from public.job_line_items u
                    where u.job_id = i.job_id and u.name = il.name and u.discount_billing is null and u.unit_price < 0
                      and (u.taxable = il.taxable or u.unit_price = il.unit_price)) as typed
      from public.invoice_line_items il join public.invoices i on i.id = il.invoice_id
     where il.discount_quote_id is null and il.service_id is null and il.unit_price < 0
       and exists (select 1 from lines m where m.job_id = i.job_id and m.name = il.name)
  ),
  picked as (
    select c.id, coalesce(
             -- The discounts with this price, in turn: two change orders of the same amount each get
             -- theirs, and a typed one's copies stay plain (no key).
             (select m.discount_key from marked m
               where m.job_id = c.job_id and m.name = c.name and m.taxable = c.taxable and m.unit_price = c.unit_price
                 and m.rn = (c.nth - 1) % m.alike + 1),
             -- A price changed on the draft: the job's only discount with that name and part. Not
             -- when the line could be a typed one's copy, so those (their Taxable box changed too,
             -- maybe) are never taken for the code's.
             (select min(m.discount_key::text)::uuid from lines m
               where m.job_id = c.job_id and m.name = c.name and m.taxable = c.taxable and not c.typed
              having count(*) = 1),
             -- A Taxable box changed since, on the draft or on the job's line: the job's only
             -- discount with that name, on the same terms.
             (select min(m.discount_key::text)::uuid from lines m
               where m.job_id = c.job_id and m.name = c.name and not c.typed
              having count(distinct m.discount_key) = 1)) as discount_key
      from candidates c
  )
  update public.invoice_line_items il set discount_quote_id = p.discount_key
    from picked p
   where p.id = il.id and p.discount_key is not null;
  alter table public.invoice_line_items enable trigger lines_guard;
  alter table public.invoice_line_items enable trigger touch_invoice;
  alter table public.invoice_line_items enable trigger promo_line_guard;
  alter table public.invoice_line_items enable trigger promo_line_fit;

  -- The jobs marked now: their invoices that hold less of a discount than the job's lines take off.
  insert into public.job_discount_skips (company_id, invoice_id, discount_key, created_by, held, held_elsewhere)
  select i.company_id, i.id, k.discount_key, null, h.held, k.placed - h.held
    from (select l.job_id, l.discount_key, -sum(round(l.quantity * l.unit_price, 2)) as owed,
                 coalesce((select -sum(round(il.quantity * il.unit_price, 2))
                             from public.invoice_line_items il join public.invoices i2 on i2.id = il.invoice_id
                            where i2.job_id = l.job_id and i2.status <> 'void' and il.discount_quote_id = l.discount_key), 0) as placed
            from public.job_line_items l
           where l.discount_billing = 'once' and l.job_id = any(v_jobs || v_more)
           group by l.job_id, l.discount_key) k
    join public.invoices i on i.job_id = k.job_id and i.kind in ('standard', 'visits') and i.status <> 'void'
    cross join lateral (select coalesce(-sum(round(il.quantity * il.unit_price, 2)), 0) as held
                          from public.invoice_line_items il where il.invoice_id = i.id and il.discount_quote_id = k.discount_key) h
   where h.held < k.owed
  on conflict do nothing;
  return cardinality(v_jobs) + cardinality(v_more);
end $$;
select private.backfill_job_discounts();

revoke all on function private.job_discounts_left(uuid), private.place_job_discounts(uuid), private.fit_job_discounts(uuid), private.promo_code_company(uuid),
  private.promo_line_guard(), private.promo_line_fit(), private.job_discounts_follow(), private.job_discounts_delete_lock(), private.backfill_job_discounts() from public;
-- create_invoice_for_job runs as the caller, and so do the job page and Marketing's functions.
grant execute on function private.job_discounts_left(uuid), private.place_job_discounts(uuid), private.fit_job_discounts(uuid), private.promo_code_company(uuid) to authenticated;
revoke execute on function public.job_promo_discounts(uuid), public.set_job_discount_billing(uuid, uuid, boolean),
  public.promo_code_jobs(uuid, boolean), public.set_promo_code_jobs(uuid, boolean) from public, anon;
grant execute on function public.job_promo_discounts(uuid), public.set_job_discount_billing(uuid, uuid, boolean),
  public.promo_code_jobs(uuid, boolean), public.set_promo_code_jobs(uuid, boolean) to authenticated, service_role;

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks();

notify pgrst, 'reload schema';
