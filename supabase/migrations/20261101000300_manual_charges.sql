-- Charge card (docs/autopay-plan.md): the office charges an unpaid invoice to the client's saved
-- card now, from the invoice or many at once from the Invoices list, on top of autopay's own charge
-- after each visit. It's an autopay charge like any other (source 'manual'), so the 5-minute task
-- charges it the one way autopay does (claim_autopay_charges, autopay_bill, Stripe, then
-- finish_autopay_charge), with the same claim tokens, guards against paying twice, receipts and
-- webhooks. supabase/tests/manual_charges_test.sql covers it.
--
--   autopay_charges.source        'autopay' (queued by a finished visit or job) or 'manual'
--   autopay_charges.requested_by  who pressed Charge card
--   request_manual_charges()      queues them for the amounts the office saw, and says what it did with each
--   chargeable_invoices()         the invoices it can charge now, and what's collecting the rest, for the list and the button
--
-- Only for a client with a card they agreed to be charged (private.autopay_ready), while the company
-- has autopay on and its Stripe key can charge cards, and never while Stripe is collecting it (a bank
-- payment on its way, or an invoice made in Stripe). A decline isn't tried again by itself: the
-- client gets the notice with the Pay link at once, and the office is told. The starter terms now
-- say the card is also charged for other invoices we send.
--
-- An invoice can now be charged again after a refund, so "paid by its charge" goes by the charge's
-- own Stripe invoice (autopay_paid_by_charge with when the charge was made), never one an earlier
-- charge made and the refund undid.

-- ---------------------------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------------------------

alter table public.autopay_charges add column source text not null default 'autopay' check (source in ('autopay', 'manual'));
alter table public.autopay_charges add column requested_by uuid references auth.users (id) on delete set null;
-- A manual charge is for an invoice, not a job's visits: no bill, and no job, so nothing that calls
-- off a job's charges (autopay off for the job, the job archived or reopened) touches it.
alter table public.autopay_charges alter column bill drop not null;
alter table public.autopay_charges add constraint autopay_charges_manual_check
  check ((source = 'autopay' and bill is not null) or (source = 'manual' and bill is null and job_id is null));

-- One live charge for an invoice at a time, whatever made it. A paid one no longer counts, so an
-- invoice owed again after a refund can be charged again.
drop index public.autopay_charges_invoice_idx;
create unique index autopay_charges_invoice_idx on public.autopay_charges (invoice_id)
  where invoice_id is not null and status in ('waiting', 'needs_approval', 'charging', 'processing', 'failed', 'needs_client');

-- Whether the invoice was paid by this charge: a charge_automatically Stripe invoice of it (only
-- autopay makes those) made since the charge was, is paid. One an earlier charge made, paid and then
-- refunded, doesn't count, so the client paying on Stripe's page isn't taken for the card.
drop function private.autopay_paid_by_charge(uuid);
create function private.autopay_paid_by_charge(p_invoice uuid, p_since timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.stripe_invoices s
    where s.invoice_id = p_invoice and s.collection = 'charge_automatically' and s.purpose = 'invoice' and s.status = 'paid'
      and s.created_at >= p_since
  )
$$;

-- As in 20261101000100_autopay.sql, but each charge is paid only by its own Stripe invoice
-- (autopay_paid_by_charge since it was made); otherwise it was paid another way.
create or replace function private.autopay_invoice_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'paid' and old.status <> 'paid' then
    update public.autopay_charges
    set status = 'paid', charged_at = coalesce(charged_at, now()), last_error = null, claim_token = null, locked_until = null, busy_since = null
    where invoice_id = new.id and private.autopay_paid_by_charge(new.id, created_at)
      and (status in ('processing', 'failed', 'needs_client', 'waiting', 'needs_approval') or (status = 'charging' and claim_token is null));
    update public.autopay_charges
    set status = 'called_off', last_error = 'Paid another way', claim_token = null, locked_until = null, busy_since = null
    where invoice_id = new.id and status in ('failed', 'needs_client', 'waiting', 'needs_approval')
      and not private.autopay_paid_by_charge(new.id, created_at);
  elsif new.status in ('void', 'written_off', 'draft') and old.status <> new.status then
    update public.autopay_charges
    set status = 'called_off', claim_token = null, locked_until = null, busy_since = null,
        last_error = case new.status when 'void' then 'The invoice was voided' when 'written_off' then 'The invoice was written off'
                     else 'The invoice went back to draft' end
    where invoice_id = new.id
      and (status in ('waiting', 'needs_approval', 'failed', 'needs_client') or (status = 'charging' and claim_token is null));
  end if;
  if old.status = 'draft' and new.status <> 'draft' then
    update public.autopay_charges
    set status = 'called_off', last_error = 'Sent the usual way', claim_token = null, locked_until = null, busy_since = null
    where invoice_id = new.id and status = 'needs_approval';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- The terms clients agree to
-- ---------------------------------------------------------------------------------------------

-- As in 20261101000100_autopay.sql, plus: the card is charged for other invoices we send too (core
-- starterAutopayTerms has the same words).
create or replace function private.autopay_starter_terms(p_trade text) returns text
language sql immutable security definer set search_path = '' as $$
  select case
    when p_trade = 'lawn_exterior' then
      'We charge the card on file after each visit is done, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade in ('paving', 'roofing_exteriors') then
      'We charge the card on file when the work on your job is done, and for other invoices we send you. Charges over the amount we agreed wait until we''ve talked with you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    else
      'We charge the card on file when each visit or job is done, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- Whether the office can charge saved cards now: autopay on in Settings, and the company's Stripe
-- key can save and charge cards (the capability the Apps page saved, as autopay_set_settings reads it).
create function private.manual_charges_on(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.companies c where c.id = p_company and private.autopay_of(c.settings) -> 'enabled' = 'true'::jsonb)
     and exists (select 1 from public.integrations i
                 where i.company_id = p_company and i.provider = 'stripe' and i.status = 'connected' and i.settings -> 'autopay' = 'true'::jsonb)
$$;

-- What's collecting the invoice already, in Charge card's words: its live charge (the one
-- autopay_charges_invoice_idx allows), else a bank payment on its way through Stripe (not one in a
-- Stripe account Crewtavo left: the office follows that there). Nulls when nothing is.
--   live_status  charging | waiting_on_client | retrying | needs_approval | bank_clearing
create function private.live_charge(p_invoice uuid, out live_status text, out live_detail text)
language sql stable security definer set search_path = '' as $$
  select x.s, case x.s
      when 'needs_approval' then 'A charge for it is waiting for your OK'
      when 'bank_clearing' then 'A bank payment for it is on its way'
      when 'retrying' then 'Autopay will try it again'
      when 'waiting_on_client' then 'It''s waiting on the client to pay or update their card'
      when 'charging' then 'It''s being charged now' end
  from (select coalesce(
    (select case a.status when 'needs_approval' then 'needs_approval' when 'processing' then 'bank_clearing' when 'failed' then 'retrying'
                          when 'needs_client' then 'waiting_on_client' else 'charging' end
     from public.autopay_charges a
     where a.invoice_id = p_invoice and a.status in ('waiting', 'needs_approval', 'charging', 'processing', 'failed', 'needs_client')),
    -- A bank payment on its way, as the charge task's waiting() counts it: in a Stripe account
    -- Crewtavo has left too, for the 30 days it may still clear there.
    (select 'bank_clearing' from public.stripe_invoices s where s.invoice_id = p_invoice and s.status = 'processing'
       and (s.detached_at is null or s.detached_at > now() - interval '30 days') limit 1)
  ) as s) x
$$;

-- Whether the invoice was made in Stripe: it's charged there, never by Charge card (the charge task
-- refuses any invoice with a Stripe-made invoice behind it, open or not, as the Client Hub does).
create function private.stripe_collects(p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stripe_invoices s where s.invoice_id = p_invoice and s.purpose = 'invoice' and s.origin = 'stripe')
$$;

-- ---------------------------------------------------------------------------------------------
-- The office's functions (each checks the caller)
-- ---------------------------------------------------------------------------------------------

/**
 * Charge card, for one invoice or up to 50: each is queued as a manual charge due now, approved by
 * the caller for the amount they saw (p_amounts, dollars, one for each of p_invoices), to the card
 * the client agreed to, and the task charges it. Owners, admins and the office with the invoices
 * area. Says for each invoice, in the order given (an invoice given twice counts once, with its
 * first amount):
 *
 *   queued       on its way to the card (an activity row says who, which invoice, how much, which card)
 *   not_found    not this company's invoice
 *   autopay_off  autopay is off in Settings, or the Stripe key can't charge cards
 *   not_owed     paid, voided, written off, nothing owed on it, or made in Stripe (charged there)
 *   in_progress  a charge for it is already under way, waiting on the office or on the client, or
 *                a bank payment for it is on its way (live_charge)
 *   no_card      the client has no card they agreed to be charged (none, paused, or needing an update)
 *   changed      what's owed isn't the amount the office saw: nothing is queued, and the reason
 *                says what it is now
 *
 * What's too small for Stripe to charge is the task's to find (it calls the charge off, and the
 * office is told): the smallest charge depends on the currency, which Stripe's code knows.
 */
create function public.request_manual_charges(p_company uuid, p_invoices uuid[], p_amounts numeric[])
returns table (invoice_id uuid, outcome text, reason text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_on boolean;
  v_id uuid;
  v_amount numeric;
  v_live text;
  v_detail text;
  v_pm uuid;
  v_charge uuid;
  i public.invoices;
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'invoices')) then
    raise exception 'Only the office with the invoices area can do that' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_invoices), 0) > 50 then
    raise exception 'Choose up to 50 invoices at a time' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_amounts), 0) <> coalesce(cardinality(p_invoices), 0) then
    raise exception 'Send the amount you saw for each invoice' using errcode = '22023';
  end if;
  v_on := private.manual_charges_on(p_company);

  for v_id, v_amount in
    select x.u, x.a from (
      select distinct on (t.u) t.u, t.a, t.n from unnest(p_invoices, p_amounts) with ordinality t(u, a, n) where t.u is not null order by t.u, t.n
    ) x order by x.n
  loop
    invoice_id := v_id;
    reason := null;
    -- Locked, so two presses at once queue one charge.
    select * into i from public.invoices x where x.id = v_id and x.company_id = p_company for update;
    if not found then
      outcome := 'not_found';
      reason := 'Invoice not found';
    elsif not v_on then
      outcome := 'autopay_off';
      reason := case when exists (select 1 from public.companies c where c.id = p_company and private.autopay_of(c.settings) -> 'enabled' = 'true'::jsonb)
        then 'Update your Stripe key on the Apps page' else 'Turn on autopay in Settings → Payments' end;
    elsif i.status not in ('draft', 'sent', 'partially_paid', 'overdue') or i.balance_due <= 0 then
      outcome := 'not_owed';
      reason := case i.status when 'paid' then 'It''s paid' when 'void' then 'It was voided' when 'written_off' then 'It was written off' else 'Nothing is owed on it' end;
    elsif private.stripe_collects(i.id) then
      outcome := 'not_owed';
      reason := 'It was made in Stripe. Charge it there';
    else
      select l.live_status, l.live_detail into v_live, v_detail from private.live_charge(i.id) l;
      v_pm := private.autopay_ready(p_company, i.client_id);
      if v_live is not null then
        outcome := 'in_progress';
        reason := v_detail;
      elsif v_pm is null then
        outcome := 'no_card';
        reason := case
          when exists (select 1 from public.autopay_authorizations a where a.company_id = p_company and a.client_id = i.client_id and a.revoked_at is null and a.paused_at is not null)
            then 'Autopay is paused for this client'
          when exists (select 1 from public.autopay_authorizations a where a.company_id = p_company and a.client_id = i.client_id and a.revoked_at is null)
            then 'The client''s card needs updating'
          else 'No saved card the client agreed to' end;
      -- The office confirmed an amount: a line changed since (or a payment) asks them again.
      elsif round(v_amount, 2) is distinct from i.balance_due then
        outcome := 'changed';
        reason := format('The amount changed to %s. Check it and try again', private.money(i.balance_due));
      else
        insert into public.autopay_charges (company_id, client_id, source, invoice_id, payment_method_id, due_at, status,
          approved_by, approved_at, approved_amount, requested_by)
        values (p_company, i.client_id, 'manual', i.id, v_pm, now(), 'waiting', v_user, now(), i.balance_due, v_user)
        returning id into v_charge;
        perform private.emit(p_company, 'autopay.charge_requested', 'invoice', i.id,
          format('Charging %s to %s''s %s for invoice #%s', private.money(i.balance_due), private.client_name(i.client_id), private.method_label_of(v_pm), i.number),
          jsonb_build_object('charge_id', v_charge, 'number', i.number, 'amount', i.balance_due, 'card', private.method_label_of(v_pm),
            'client_id', i.client_id, 'requested_by', v_user));
        outcome := 'queued';
      end if;
    end if;
    return next;
  end loop;
end $$;

/**
 * The invoices Charge card can charge now (owners, admins and the office with the invoices area):
 * owed, and their client has a card they agreed to be charged, newest first, with the card's name and
 * what's collecting it already, if anything (live_charge: in_progress, live_status and live_detail;
 * the list shows it, not to be picked). Not one made in Stripe, which is charged there
 * (stripe_collects). Nothing while autopay is off or the Stripe key can't charge cards. The list (no
 * p_invoice) leaves drafts out, which haven't gone to the client yet; asked about one invoice (the
 * invoice page's button), a draft counts.
 */
create function public.chargeable_invoices(p_company uuid, p_invoice uuid default null)
returns table (id uuid, number bigint, client_id uuid, client_name text, balance_due numeric, due_on date, status text, card text,
               in_progress boolean, live_status text, live_detail text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'invoices')) then
    raise exception 'Only the office with the invoices area can do that' using errcode = '42501';
  end if;
  if not private.manual_charges_on(p_company) then
    return;
  end if;
  return query
    select i.id, i.number, i.client_id, c.display_name, i.balance_due, i.due_on, i.status, private.method_label_of(r.pm),
           l.live_status is not null, l.live_status, l.live_detail
    from public.invoices i
    join public.clients c on c.id = i.client_id
    cross join lateral (select private.autopay_ready(p_company, i.client_id) as pm) r
    cross join lateral private.live_charge(i.id) l
    where i.company_id = p_company and r.pm is not null and i.balance_due > 0
      and (i.status in ('sent', 'partially_paid', 'overdue') or (p_invoice is not null and i.status = 'draft'))
      and (p_invoice is null or i.id = p_invoice)
      and not private.stripe_collects(i.id)
    order by i.created_at desc, i.id
    -- shortcut: the newest 500 only; page it if a company ever has more owed on saved cards.
    limit 500;
end $$;

-- ---------------------------------------------------------------------------------------------
-- The task's functions
-- ---------------------------------------------------------------------------------------------

/**
 * As in 20261101000100_autopay.sql, plus manual charges. One is billed already (its invoice), and
 * the office pressed it: no job, visits, dates or cap to check. It still needs autopay on, the
 * client's agreement in force (autopay_ready), and the invoice owed, for the client it was pressed
 * for and for no more than the office saw then (approved_amount).
 *
 * Bill a claimed charge: make its invoice (a draft) when it has none, then say what to do next.
 * Runs only while the caller holds the claim. Money stays in one transaction here.
 *
 * Returns {outcome: 'charge', invoice_id, invoice_status, balance_due, method: {id,
 * stripe_payment_method_id, stripe_customer_id, livemode, stripe_account, type}}, or {outcome:
 * 'called_off' | 'paid' | 'needs_approval' | 'lost', reason, invoice_id}. All but 'charge' and 'lost'
 * have already written the row and let go of the claim.
 */
create or replace function public.autopay_bill(p_charge uuid, p_token uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
  j public.jobs;
  i public.invoices;
  m public.client_payment_methods;
  v_autopay jsonb;
  v_pm uuid;
  v_invoice uuid;
  v_accepted timestamptz;
  v_since timestamptz;
  v_reason text;
  v_max numeric;
begin
  select * into r from public.autopay_charges where id = p_charge for update;
  if not found or p_token is null or r.status <> 'charging' or r.claim_token is distinct from p_token then
    return jsonb_build_object('outcome', 'lost', 'reason', null, 'invoice_id', r.invoice_id);
  end if;

  -- 1. Billed already (a retry, an approved charge, or a manual one): what's become of the invoice.
  if r.invoice_id is not null then
    select * into i from public.invoices where id = r.invoice_id for update;
    if i.status = 'paid' then
      if private.autopay_paid_by_charge(i.id, r.created_at) then
        return private.autopay_bill_end(r.id, 'paid', null);   -- went through before its worker stopped
      end if;
      return private.autopay_bill_end(r.id, 'called_off', 'Paid another way');
    end if;
    -- Stripe credit paid its own Stripe invoice in full before it was marked sent (its worker stopped
    -- between): sent now, as finish_autopay_charge does, so invoice_totals makes it paid.
    if i.status = 'draft' and i.balance_due <= 0 and private.autopay_paid_by_charge(i.id, r.created_at) then
      update public.invoices set status = 'sent' where id = i.id and status = 'draft';
      -- Nothing on the card: a draft is only paid before /pay, so by credit.
      update public.autopay_charges set charged_amount = 0 where id = r.id;
      return private.autopay_bill_end(r.id, 'paid', null);
    end if;
    if i.status not in ('draft', 'sent', 'partially_paid', 'overdue') or i.balance_due <= 0 then
      return private.autopay_bill_end(r.id, 'called_off', case i.status when 'void' then 'The invoice was voided'
        when 'written_off' then 'The invoice was written off' else 'Nothing is owed on it' end);
    end if;
    -- Charge card is for the invoice as the office saw it.
    if r.source = 'manual' and i.client_id is distinct from r.client_id then
      return private.autopay_bill_end(r.id, 'called_off', 'The invoice is for another client now');
    end if;
    if r.source = 'manual' and i.balance_due > r.approved_amount then
      return private.autopay_bill_end(r.id, 'called_off', 'The invoice changed after Charge card was pressed. Charge it again');
    end if;
  elsif r.source = 'manual' then
    return private.autopay_bill_end(r.id, 'called_off', 'The invoice was deleted');
  end if;

  -- 2. Still on, on fresh data (the same checks billed or not; the status trigger tells the office
  -- when that leaves an invoice unpaid). A manual charge has no job or bill, so only the company's
  -- switch and the client's agreement apply to it.
  select * into j from public.jobs where id = r.job_id;
  select private.autopay_of(c.settings) into v_autopay from public.companies c where c.id = r.company_id;
  v_pm := private.autopay_ready(r.company_id, r.client_id);
  if r.source = 'autopay' and (j.id is null or not j.autopay or j.status = 'archived') then
    return private.autopay_bill_end(r.id, 'called_off', 'Autopay is off for this job');
  end if;
  if v_autopay -> 'enabled' is distinct from 'true'::jsonb then
    return private.autopay_bill_end(r.id, 'called_off', 'Autopay is turned off in Settings');
  end if;
  if v_pm is null then
    return private.autopay_bill_end(r.id, 'called_off', 'Autopay is off for this client');
  end if;
  if r.bill = 'standard' and r.invoice_id is null and j.status <> 'requires_invoicing' then
    return private.autopay_bill_end(r.id, 'called_off', 'The job isn''t waiting to be billed');
  end if;
  if r.bill = 'visits' and r.invoice_id is not null
     and exists (select 1 from public.visits v where v.invoice_id = r.invoice_id and v.status <> 'completed') then
    return private.autopay_bill_end(r.id, 'called_off', 'A visit on it was reopened');
  end if;
  update public.autopay_charges set payment_method_id = v_pm where id = r.id;

  -- 3. No invoice yet: make it, as the office's Invoice button would (this runs as the function's
  -- owner, past row-level security). It bills every finished visit of the job not yet billed. Those
  -- that queued another of the job's charges still gathering visits (one made while this was
  -- claimed) count as queued for this one too: that charge has nothing left to bill.
  if r.invoice_id is null then
    begin
      v_invoice := public.create_invoice_for_job(r.job_id, r.bill);
    exception when sqlstate '22023' or sqlstate 'P0002' then
      return private.autopay_bill_end(r.id, 'called_off', left(sqlerrm, 1000));
    end;
    update public.autopay_charges a
    set invoice_id = v_invoice,
        visit_ids = a.visit_ids || array(
          select distinct x
          from public.autopay_charges o cross join lateral unnest(o.visit_ids) x
          join public.visits v on v.id = x and v.invoice_id = v_invoice
          where o.job_id = r.job_id and o.id <> r.id and o.status in ('waiting', 'charging') and o.invoice_id is null
            and x <> all (a.visit_ids))
    where a.id = r.id
    returning a.visit_ids into r.visit_ids;
    r.invoice_id := v_invoice;
  end if;
  select * into i from public.invoices where id = r.invoice_id for update;

  -- 4. Asking first, only while the invoice is still a draft, and only for autopay's own charges.
  -- Autopay charges without the office's OK only for visits it queued itself (visit_ids: finished
  -- while autopay was in force for the client and the job). A visit freed by a voided or deleted
  -- invoice, or finished while autopay was paused, off in Settings or off for the job, wasn't, so
  -- the bill waits for Approve charge. The dates are checked too, for a visit finished offline (or
  -- marked done later) before autopay started, or while it was paused, and queued when it synced (an
  -- offline Complete keeps its tap time as completed_at: visit_defaults, visit_sub_guard): from the
  -- start of the client's unbroken run of agreements (a card changed, revoked_via 'replaced',
  -- doesn't break it), from when the job's autopay went on, and from when the office last resumed it
  -- (resumed_at).
  if i.status = 'draft' and r.source = 'autopay' then
    -- Work an AI assistant marked done (autopay_queue): the office looks first, whatever the amount.
    if r.held is not null and r.approved_at is null then
      update public.autopay_charges
      set status = 'needs_approval', last_error = r.held, claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
      return jsonb_build_object('outcome', 'needs_approval', 'reason', r.held, 'invoice_id', i.id);
    end if;
    if r.bill = 'visits' and r.approved_at is null then
      select min(a.accepted_at) into v_accepted from public.autopay_authorizations a
      where a.company_id = r.company_id and a.client_id = r.client_id
        and a.accepted_at > coalesce((
          select max(b.revoked_at) from public.autopay_authorizations b
          where b.company_id = r.company_id and b.client_id = r.client_id and b.revoked_at is not null and b.revoked_via <> 'replaced'
        ), '-infinity'::timestamptz);
      select greatest(v_accepted, coalesce(j.autopay_since, '-infinity'::timestamptz), coalesce(a.resumed_at, '-infinity'::timestamptz))
      into v_since from public.autopay_authorizations a
      where a.company_id = r.company_id and a.client_id = r.client_id and a.revoked_at is null;
      v_reason := case
        when exists (select 1 from public.visits v where v.invoice_id = i.id and v.completed_at < v_since)
          then 'Includes visits from before autopay started'
        when exists (select 1 from public.visits v where v.invoice_id = i.id and v.id <> all (r.visit_ids))
          then 'Includes visits autopay didn''t queue (finished while it was off, or from a voided invoice)'
      end;
      if v_reason is not null then
        update public.autopay_charges
        set status = 'needs_approval', last_error = v_reason, claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
        return jsonb_build_object('outcome', 'needs_approval', 'reason', v_reason, 'invoice_id', i.id);
      end if;
    end if;
    v_max := case when jsonb_typeof(v_autopay -> 'max_amount') = 'number' then (v_autopay -> 'max_amount')::numeric end;
    if v_max is not null and i.balance_due > v_max and (r.approved_at is null or i.balance_due > r.approved_amount) then
      update public.autopay_charges
      set status = 'needs_approval', last_error = null, claim_token = null, locked_until = null, busy_since = null,
          approved_at = null, approved_by = null, approved_amount = null
      where id = r.id;
      return jsonb_build_object('outcome', 'needs_approval', 'reason', null, 'invoice_id', i.id);
    end if;
  end if;

  -- 5. Charge it: the claim is held for the Stripe calls.
  update public.autopay_charges set locked_until = now() + interval '5 minutes' where id = r.id;
  select * into m from public.client_payment_methods where id = v_pm;
  return jsonb_build_object(
    'outcome', 'charge', 'invoice_id', i.id, 'invoice_status', i.status, 'balance_due', i.balance_due,
    'method', jsonb_build_object('id', m.id, 'stripe_payment_method_id', m.stripe_payment_method_id,
      'stripe_customer_id', m.stripe_customer_id, 'livemode', m.livemode, 'stripe_account', m.stripe_account, 'type', m.type));
end $$;

/**
 * As in 20261101000100_autopay.sql, plus: a manual charge declined isn't tried again by itself. It
 * needs the client at once (the notice with the Pay link, and the office told), with the decline
 * counted but the card left as it is: one decline the office asked for doesn't pause autopay. A
 * decline without Stripe's code is kept as 'card_declined', so it never reads as the bank asking
 * the client to confirm.
 *
 * How a charge went. False when the caller no longer holds it. With p_token: the task, while it
 * holds the claim. Without: the webhook, for a bank payment on its way ('processing'), only 'paid'
 * or 'bank_failed', and only for p_company's own charge.
 *
 *   paid          paid, with what Stripe charged
 *   processing    a bank payment is on its way
 *   declined      failed, tried again in 3 days; the second in a row needs the client, and the card
 *                 needs updating (a manual charge needs the client the first time)
 *   bank_failed   a bank payment bounced: needs the client, never retried (presenting a closed or
 *                 unauthorized account again breaks Nacha rules and costs a fee)
 *   needs_client  the client has to do something (confirm with their bank, a card Stripe refused)
 *   called_off    with why
 *   retry         Stripe was down or rate-limited, or the task threw: tried again in 10 minutes, and
 *                 the attempt counts
 *   busy          Stripe's invoice is still being made, or a bank payment is on its way: tried again
 *                 in 10 minutes without using an attempt, and called off after a day of it
 */
create or replace function public.finish_autopay_charge(p_id uuid, p_outcome text, p_token uuid default null,
  p_error text default null, p_decline text default null, p_amount numeric default null, p_company uuid default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
  v_error text := left(p_error, 1000);
  v_decline text := left(p_decline, 100);
begin
  if p_outcome is null or p_outcome not in ('paid', 'processing', 'declined', 'bank_failed', 'needs_client', 'called_off', 'retry', 'busy') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  select * into r from public.autopay_charges where id = p_id for update;
  if not found then
    return false;
  end if;
  if p_token is not null then
    if r.status <> 'charging' or r.claim_token is distinct from p_token or (p_company is not null and r.company_id <> p_company) then
      return false;
    end if;
  elsif p_company is null or r.company_id <> p_company or r.status <> 'processing' or p_outcome not in ('paid', 'bank_failed') then
    return false;
  end if;

  case p_outcome
    when 'paid' then
      update public.autopay_charges
      set status = 'paid', charged_at = now(), charged_amount = coalesce(p_amount, charged_amount), last_error = null,
          claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
      -- Paid before it was marked sent (Stripe credit paid it all as its Stripe invoice was made):
      -- it's sent, so it doesn't stay a draft carrying a payment (invoice_totals then makes it paid).
      update public.invoices set status = 'sent' where id = r.invoice_id and status = 'draft';
    when 'processing' then
      update public.autopay_charges
      set status = 'processing', charged_amount = p_amount, claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
    when 'declined' then
      if r.source = 'manual' then
        update public.autopay_charges
        set status = 'needs_client', failures = r.failures + 1, last_error = v_error, decline_code = coalesce(v_decline, 'card_declined'),
            claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
      elsif r.failures + 1 >= 2 then
        update public.client_payment_methods set status = 'needs_update' where id = r.payment_method_id and status = 'active';
        update public.autopay_charges
        set status = 'needs_client', failures = r.failures + 1, last_error = v_error, decline_code = v_decline,
            claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
      else
        update public.autopay_charges
        set status = 'failed', failures = r.failures + 1, due_at = now() + interval '3 days', last_error = v_error, decline_code = v_decline,
            claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
      end if;
    when 'bank_failed' then
      update public.client_payment_methods set status = 'needs_update' where id = r.payment_method_id and status = 'active';
      update public.autopay_charges
      set status = 'needs_client', failures = r.failures + 1, last_error = coalesce(v_error, 'The bank payment didn''t go through'),
          decline_code = coalesce(v_decline, 'bank_failed'), claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
    when 'needs_client' then
      update public.autopay_charges
      set status = 'needs_client', last_error = v_error, decline_code = v_decline, claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
    when 'called_off' then
      update public.autopay_charges
      set status = 'called_off', last_error = v_error, claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
    when 'retry' then
      update public.autopay_charges
      set claim_token = null, locked_until = now() + interval '10 minutes', last_error = v_error
      where id = r.id;
    when 'busy' then
      if r.busy_since < now() - interval '1 day' then
        update public.autopay_charges
        set status = 'called_off', last_error = 'Stripe was busy with this for a day. Check the invoice and Stripe',
            claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
      else
        update public.autopay_charges
        set claim_token = null, locked_until = now() + interval '10 minutes', last_error = v_error,
            attempts = greatest(r.attempts - 1, 0), busy_since = coalesce(r.busy_since, now())
        where id = r.id;
      end if;
  end case;
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Who's told what
-- ---------------------------------------------------------------------------------------------

-- As in 20261101000100_autopay.sql, plus: a manual charge's card declined tells the office it was
-- declined once, and that the client was sent the Pay link (autopay isn't paused for it).
--
-- paid (from charging or processing): the receipt, but not between tries after a busy Stripe
-- (charging, no claim, busy_since set): autopay charged nothing then, so the client paid its Stripe
-- invoice on Stripe's page themselves. failed and needs_client: the client's notice,
-- the office's notification and autopay.failed, only when it's a new failure (so a claim released
-- back to 'failed' tells nobody twice). needs_approval: the office. called_off with an invoice left
-- as a draft or still owed: its Stripe invoice is brought in step (syncStripeInvoice voids a
-- charge_automatically one nothing will pay now) and the office is told, unless it did it itself.
-- Not when it was paid another way and that payment is still being booked (the server calls a
-- charge off just before it books the client paying autopay's Stripe invoice with another card).
create or replace function private.autopay_charge_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_client text := private.client_name(new.client_id);
  v_link text := case when new.invoice_id is not null then '/invoices/' || new.invoice_id else '/clients/' || new.client_id end;
  v_tz text;
  v_card text := private.method_label_of(new.payment_method_id);
  v_bank boolean;
  v_body text;
  i public.invoices;
begin
  if new.invoice_id is not null then
    select * into i from public.invoices where id = new.invoice_id;
  end if;
  select coalesce(c.timezone, 'UTC') into v_tz from public.companies c where c.id = new.company_id;

  if new.status = 'paid' and (old.status = 'processing'
                              or (old.status = 'charging' and (old.claim_token is not null or old.busy_since is null))) then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'autopay.receipt', jsonb_build_object('charge_id', new.id));

  elsif new.status in ('failed', 'needs_client')
        and (new.failures > old.failures or (new.status = 'needs_client' and old.status in ('charging', 'processing'))) then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'autopay.notice', jsonb_build_object('charge_id', new.id, 'status', new.status, 'failures', new.failures));
    if new.status = 'failed' then
      perform private.autopay_notify(new.company_id, format('Autopay failed: %s', v_client),
        format('Invoice #%s · %s. We''ll try again on %s.', i.number, rtrim(coalesce(new.last_error, 'The card was declined'), '.'),
               to_char(new.due_at at time zone v_tz, 'Mon FMDD')),
        v_link);
    else
      v_bank := old.status = 'processing'
        or exists (select 1 from public.client_payment_methods pm where pm.id = new.payment_method_id and pm.type = 'us_bank_account');
      v_body := case
        when new.failures > old.failures and v_bank then 'Their bank payment didn''t go through, so autopay is paused until they update it.'
        when new.failures > old.failures and new.source = 'manual' then 'The card was declined, so they were sent the Pay link and a way to update their card.'
        when new.failures > old.failures then 'The card was declined twice, so autopay is paused until they update it.'
        when new.last_error is null or new.decline_code in ('authentication_required', 'invoice_payment_intent_requires_action', 'requires_action')
          then 'Their bank wants them to confirm the payment.'
        else new.last_error
      end;
      perform private.autopay_notify(new.company_id, format('Autopay needs %s', v_client), v_body, v_link);
    end if;
    if new.invoice_id is not null then
      perform private.emit(new.company_id, 'autopay.failed', 'invoice', new.invoice_id,
        format('Autopay failed for invoice #%s (%s)', i.number, v_client),
        jsonb_build_object('client_id', new.client_id, 'card', v_card, 'reason', new.last_error, 'status', new.status));
    end if;

  elsif new.status = 'needs_approval' then
    perform private.autopay_notify(new.company_id, format('Approve a %s charge for %s', private.money(i.balance_due), v_client),
      coalesce(new.last_error, 'It''s over your autopay limit, so it waits for your OK.'), v_link);

  elsif new.status = 'called_off' and new.invoice_id is not null and i.id is not null
        and new.last_error is distinct from 'The invoice was deleted' then
    if i.status = 'draft' then
      perform private.autopay_enqueue_stripe(new.company_id, new.invoice_id);
      if new.last_error is null or new.last_error not in ('Called off by the office', 'The invoice went back to draft') then
        perform private.autopay_notify(new.company_id, format('Send invoice #%s to %s the usual way', i.number, v_client), new.last_error, v_link);
      end if;
    elsif i.status in ('sent', 'partially_paid', 'overdue') and i.balance_due > 0 and new.last_error is distinct from 'Paid another way' then
      perform private.autopay_enqueue_stripe(new.company_id, new.invoice_id);
      if new.last_error is null or new.last_error not in ('Called off by the office', 'Sent the usual way') then
        perform private.autopay_notify(new.company_id, format('Invoice #%s for %s wasn''t charged', i.number, v_client),
          format('%s. It''s owed as usual; send a reminder if they need the Pay link.', rtrim(coalesce(new.last_error, 'Autopay was called off'), '.')), v_link);
      end if;
    end if;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Who calls what
-- ---------------------------------------------------------------------------------------------

revoke all on function private.manual_charges_on(uuid), private.live_charge(uuid), private.stripe_collects(uuid),
  private.autopay_paid_by_charge(uuid, timestamptz) from public;
revoke execute on function public.request_manual_charges(uuid, uuid[], numeric[]), public.chargeable_invoices(uuid, uuid) from public, anon;
grant execute on function public.request_manual_charges(uuid, uuid[], numeric[]), public.chargeable_invoices(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
