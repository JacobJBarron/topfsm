-- A referral credit doesn't go on or come off an invoice while autopay is charging it. Stripe
-- charges the amount the invoice had when the charge started, so a credit landing then (the friend
-- paying that minute, or the office's Apply credit) would have the client pay more than they owe.
-- It goes on another invoice, or waits, as it does while a bank payment clears. As in
-- 20261031000100_referral_credits.sql, plus that; every credit path asks this function.
create or replace function private.referral_credits_changeable(p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select i.status in ('draft', 'sent', 'overdue')
     and not exists (select 1 from public.payments p where p.invoice_id = i.id)
     and not exists (select 1 from public.stripe_invoices s where s.invoice_id = i.id and (s.origin = 'stripe' or s.status = 'processing'))
     and not exists (select 1 from public.autopay_charges a where a.invoice_id = i.id and a.status = 'charging')
  from public.invoices i where i.id = p_invoice
$$;
