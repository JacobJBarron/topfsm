-- A draft voided was never sent, so it doesn't get a sent date (it showed "Sent" with the day it was
-- voided). Invoices voided before this keep the date they have: there's no telling which were sent.

-- As in 20261031000100_referral_credits.sql, except that a void invoice isn't given a sent date.
create or replace function private.invoice_totals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_sub numeric; v_taxable numeric; v_base numeric; v_base_taxable numeric; v_lines integer;
  v_discount numeric; v_credits numeric; v_off numeric; v_paid numeric; v_today date;
begin
  if tg_op = 'UPDATE' and old.status = 'void' and new.status = 'void' then
    new.subtotal := old.subtotal;
    new.discount_amount := old.discount_amount;
    new.credit_amount := old.credit_amount;
    new.tax_amount := old.tax_amount;
    new.total := old.total;
    new.retainage_amount := old.retainage_amount;
    new.amount_paid := coalesce((select sum(amount) from public.payments where invoice_id = new.id), 0);
    new.balance_due := new.total - new.retainage_amount - new.amount_paid;
    return new;
  end if;
  select coalesce(sum(round(quantity * unit_price, 2)), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0), 0),
         coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable and unit_price > 0), 0),
         count(*)
    into v_sub, v_taxable, v_base, v_base_taxable, v_lines
  from public.invoice_line_items where invoice_id = new.id;
  select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = new.id;
  select (now() at time zone coalesce(c.timezone, 'UTC'))::date into v_today from public.companies c where c.id = new.company_id;

  if new.promo_code_id is not null then
    new.discount_amount := coalesce(private.promo_discount(new.promo_code_id, v_base), 0);
  end if;
  v_discount := least(new.discount_amount, greatest(v_sub, 0));
  select coalesce(sum(amount), 0) into v_credits from public.referral_credits where invoice_id = new.id;
  new.credit_amount := least(v_credits, greatest(v_sub - v_discount, 0));
  v_off := v_discount + new.credit_amount;
  new.subtotal := v_sub;
  new.tax_amount := round(greatest(v_taxable - case when v_base > 0 then v_off * v_base_taxable / v_base else 0 end, 0) * new.tax_rate, 2);
  new.total := v_sub - v_off + new.tax_amount;
  new.retainage_amount := round(greatest(new.total, 0) * new.retainage_pct / 100, 2);
  new.amount_paid := v_paid;
  new.balance_due := new.total - new.retainage_amount - v_paid;

  if new.status = 'written_off' and (tg_op = 'INSERT' or old.status <> 'written_off') then
    -- Being written off now: invoice_void_guard checks there's something owed to write off.
    if tg_op = 'INSERT' then
      raise exception 'Send an invoice before writing it off' using errcode = '22023';
    end if;
  elsif new.status = 'written_off' then
    -- Paid after all.
    if v_lines > 0 and new.balance_due <= 0 then
      new.status := 'paid';
    end if;
  elsif new.status not in ('draft', 'void') then
    new.status := case
      when v_lines > 0 and new.balance_due <= 0 then 'paid'
      when new.due_on is not null and new.due_on < coalesce(v_today, current_date) then 'overdue'
      when v_paid > 0 then 'partially_paid'
      else 'sent'
    end;
  end if;
  new.written_off_at := case when new.status = 'written_off' then coalesce(new.written_off_at, now()) end;
  if new.status not in ('draft', 'void') and new.sent_at is null then
    new.sent_at := now();
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
