-- A promo code can't go on or come off an invoice while a bank payment for it is on its way through
-- Stripe (docs/marketing-plan.md, "Promo code fixes"): the client is paying what Stripe asked for, and
-- a new total would leave the invoice short or paid twice. The office's promo box and the Client
-- Hub's say why.

-- A bank payment for the invoice is on its way, as the app counts one (waiting() in
-- apps/api/src/integrations/stripe.ts, which the Client Hub's promo box and Pay follow): a Stripe
-- invoice processing, test money only while the key in use is a test key, and one in a Stripe
-- account Crewtavo has since left (detached) only for the 30 days a bank payment can take, after
-- which it has cleared or bounced there. The key in use is the company's own when Stripe is connected
-- on the Apps page (the mode it was connected with), else the deployment's, which the database can't
-- see: then test money counts, as under a test key.
create function private.bank_payment_clearing(p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.stripe_invoices s
     where s.invoice_id = p_invoice and s.status = 'processing'
       and (s.detached_at is null or s.detached_at > now() - interval '30 days')
       and (s.livemode or not coalesce((select (g.settings ->> 'livemode')::boolean from public.integrations g
                                         where g.company_id = s.company_id and g.provider = 'stripe' and g.status = 'connected'), false)))
$$;
revoke all on function private.bank_payment_clearing(uuid) from public;
grant execute on function private.bank_payment_clearing(uuid) to authenticated, service_role;

-- As in 20261025000100_contracts_and_options.sql, with the bank payment check on invoices.
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

-- As in 20261017001600_promo_codes.sql. On an invoice with a bank payment on its way it says why,
-- rather than leaving the code on without a word.
create or replace function public.remove_promo_code(p_kind text, p_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_kind = 'quote' then
    update public.quotes set promo_code_id = null, discount_amount = 0
    where id = p_id and promo_code_id is not null and status in ('draft', 'sent', 'changes_requested');
  elsif p_kind = 'invoice' then
    if exists (select 1 from public.invoices i where i.id = p_id and i.promo_code_id is not null and private.bank_payment_clearing(i.id)) then
      raise exception 'A bank payment for this invoice is on its way, so its promo code can''t change until it clears.' using errcode = '22023';
    end if;
    update public.invoices set promo_code_id = null, discount_amount = 0
    where id = p_id and promo_code_id is not null and status in ('draft', 'sent', 'overdue')
      and not exists (select 1 from public.payments where invoice_id = p_id);
  end if;
end $$;

notify pgrst, 'reload schema';
