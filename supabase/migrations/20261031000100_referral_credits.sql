-- Referral credits (docs/marketing-plan.md, phase B), Jobber's way: the client who referred a friend
-- gets a credit, a set amount or a percentage of the friend's first job, once the friend pays their
-- first invoice in full, and it goes on the referrer's next invoice by itself.
--
--   settings.referrals    {reward: {kind: 'amount' | 'percent', value}, offer, message}, in place of
--                         settings.referral_reward ({amount}) and settings.referral_offer.
--   referrals             the reward's terms are fixed when the friend arrives (reward_kind and
--                         reward_value), and its amount when it's earned (reward_amount).
--                         reward_status: pending (the friend hasn't paid yet), earned, applied (all
--                         of it is on invoices), issued (given outside Crewtavo, "Given") or none,
--                         with no_reward_reason saying why.
--   referral_credits      where each credit went: a referral's credit can be split over invoices
--                         when the first one can't take it all.
--   invoices.credit_amount the referral credits on an invoice, off before tax like the discount
--                         and after it. invoice_totals works it out from referral_credits.
--
-- When a credit goes on an invoice by itself (apply_referral_credits): the referrer's open draft
-- first, then their oldest invoice awaiting payment or past due, with no payments, not made in
-- Stripe or with a bank payment on its way, not a deposit or retainage, and not already in QuickBooks
-- or Zoho Books. Never more than what's left after discounts, so tax is still owed and the total is
-- never negative; what doesn't fit waits for the next invoice. A credit on an invoice that's voided,
-- deleted or moved to another client before it's paid is given back and goes on the next one (a
-- void invoice keeps the figures it was voided with). The friend's invoice not paid after all (a
-- payment removed, refunded or disputed) takes the credit back while it can.
--
-- Every path takes the referrer's lock first (pg_advisory_xact_lock('referral_credit:' || client)),
-- then the referral rows, then the invoice rows (skipping any another transaction is changing: its
-- own commit puts the credit on). referral_credit_guard re-checks the sums under the referral row
-- lock, whoever writes a credit. Placing a credit never fails a payment or an invoice save: a credit
-- that can't be placed stays earned and lands on the next change.
--
-- referral_credits_follow waits for commit, so a migration that writes invoices and then alters the
-- table has to fire it first; scripts/migrate.mjs does that at the start of each migration.

-- ---------------------------------------------------------------------------------------------
-- Settings: the new shape
-- ---------------------------------------------------------------------------------------------

-- settings.referral_reward ({amount}) and settings.referral_offer become settings.referrals, kept
-- where it's there already. Says how many companies changed. Only this repo wrote the old keys.
create function private.move_referral_settings() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.companies
     set settings = (coalesce(settings, '{}') - 'referral_reward' - 'referral_offer')
       || jsonb_build_object('referrals',
            jsonb_build_object(
              'reward', jsonb_build_object('kind', 'amount', 'value',
                greatest(coalesce(case when jsonb_typeof(settings #> '{referral_reward,amount}') = 'number' then (settings #>> '{referral_reward,amount}')::numeric end, 0), 0)),
              'offer', to_jsonb(nullif(trim(settings ->> 'referral_offer'), '')))
            || case when jsonb_typeof(settings -> 'referrals') = 'object' then settings -> 'referrals' else '{}'::jsonb end)
   where settings ? 'referral_reward' or settings ? 'referral_offer';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.move_referral_settings() from public;
select private.move_referral_settings();

-- The credit a new referral is offered, as packages/core/src/marketing.ts referralSettings reads it:
-- a percentage from 1 to 100, or an amount up to $10,000. Anything else is no credit.
create function private.referral_terms(p_settings jsonb) returns table (kind text, value numeric)
language sql immutable set search_path = '' as $$
  select case when k = 'percent' then 'percent' else 'amount' end,
         case when k = 'percent' and v between 1 and 100 then round(v, 2)
              when k = 'amount' and v between 0 and 10000 then round(v, 2)
              else 0 end
  from (select p_settings #>> '{referrals,reward,kind}' as k,
               case when jsonb_typeof(p_settings #> '{referrals,reward,value}') = 'number' then (p_settings #>> '{referrals,reward,value}')::numeric end as v) x
$$;
revoke all on function private.referral_terms(jsonb) from public;

-- ---------------------------------------------------------------------------------------------
-- Referrals
-- ---------------------------------------------------------------------------------------------

alter table public.referrals drop constraint referrals_reward_status_check;
alter table public.referrals add constraint referrals_reward_status_check
  check (reward_status in ('pending', 'earned', 'applied', 'issued', 'none'));
alter table public.referrals
  add column reward_kind text not null default 'amount' check (reward_kind in ('amount', 'percent')),
  add column reward_value numeric(12, 2) not null default 0,
  add column earned_at timestamptz,
  add column earned_invoice_id uuid,
  add column applied_at timestamptz,
  add column given_amount numeric(12, 2) not null default 0,
  add column auto_apply boolean not null default true,
  add column credit_anyway boolean not null default false,
  add column no_reward_reason text check (no_reward_reason in ('not_set', 'self', 'already_client', 'lost', 'by_hand')),
  add column lost_at timestamptz,
  add constraint referrals_company_id_id_key unique (company_id, id),
  add constraint referrals_reward_value_check check (reward_value >= 0 and (reward_kind <> 'percent' or reward_value <= 100)),
  add constraint referrals_earned_invoice_fkey foreign key (company_id, earned_invoice_id)
    references public.invoices (company_id, id) on delete set null (earned_invoice_id);
comment on column public.referrals.reward_kind is 'The credit offered when the friend arrived: an amount, or a percent of their first job';
comment on column public.referrals.reward_value is 'The amount, or the percent (1 to 100)';
comment on column public.referrals.reward_amount is 'The credit, worked out when it''s earned';
comment on column public.referrals.earned_invoice_id is 'The friend''s paid invoice that earned the credit';
comment on column public.referrals.applied_at is 'When the last of the credit went on an invoice';
comment on column public.referrals.given_amount is 'What of the credit was given outside Crewtavo (Mark given): what wasn''t on invoices then';
comment on column public.referrals.auto_apply is 'The credit goes on the referrer''s next invoice by itself (off: kept off invoices until someone applies it)';
comment on column public.referrals.credit_anyway is 'The office chose Give a credit anyway: the referred-themselves and already-a-client checks don''t apply';
comment on column public.referrals.no_reward_reason is 'Why there''s no credit: not_set, self, already_client, lost or by_hand';
create index referrals_referrer_earned_idx on public.referrals (referrer_client_id) where reward_status = 'earned';
create index referrals_earned_invoice_idx on public.referrals (earned_invoice_id) where earned_invoice_id is not null;

-- Referrals change through the functions below now, as review requests do.
drop policy referrals_update on public.referrals;
revoke update on public.referrals from authenticated;

-- A referral made with no reason for having no credit (the referral page from before this) has none
-- set; one made with only an amount has its terms from it.
create function private.referral_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.reward_status = 'none' and new.no_reward_reason is null then
    new.no_reward_reason := 'not_set';
  end if;
  if new.reward_kind = 'amount' and new.reward_value = 0 and new.reward_amount > 0 and new.earned_at is null then
    new.reward_value := new.reward_amount;
  end if;
  return new;
end $$;
create trigger referral_defaults before insert on public.referrals
  for each row execute function private.referral_defaults();

-- ---------------------------------------------------------------------------------------------
-- Credits on invoices
-- ---------------------------------------------------------------------------------------------

alter table public.invoices add column credit_amount numeric(12, 2) not null default 0 check (credit_amount >= 0);
comment on column public.invoices.credit_amount is 'Referral credits on this invoice, before tax (referral_credits). Worked out by invoice_totals.';

create table public.referral_credits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  referral_id uuid not null,
  invoice_id uuid not null,
  amount numeric(12, 2) not null check (amount > 0),
  -- What the invoice says, as it was when the credit went on ("Referral credit: thanks for referring Maria").
  note text not null check (char_length(note) <= 200),
  automatic boolean not null default true,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (referral_id, invoice_id),
  foreign key (company_id, referral_id) references public.referrals (company_id, id) on delete cascade,
  foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete cascade
);
create index referral_credits_invoice_idx on public.referral_credits (invoice_id);
create index referral_credits_referral_idx on public.referral_credits (referral_id);
alter table public.referral_credits enable row level security;
-- Read on the invoice (Invoices) and on the referral (Marketing).
create policy referral_credits_read on public.referral_credits for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and (private.has_perm(company_id, 'invoices') or private.has_perm(company_id, 'marketing')));
revoke insert, update, delete on public.referral_credits from authenticated;

-- Invoices someone took a referral's credit off: it doesn't go back on them by itself, and goes on
-- the next open invoice instead.
create table public.referral_credit_skips (
  company_id uuid not null references public.companies (id) on delete cascade,
  referral_id uuid not null,
  invoice_id uuid not null,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (referral_id, invoice_id),
  foreign key (company_id, referral_id) references public.referrals (company_id, id) on delete cascade,
  foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete cascade
);
create index referral_credit_skips_invoice_idx on public.referral_credit_skips (invoice_id);
alter table public.referral_credit_skips enable row level security;
create policy referral_credit_skips_read on public.referral_credit_skips for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and (private.has_perm(company_id, 'invoices') or private.has_perm(company_id, 'marketing')));
revoke insert, update, delete on public.referral_credit_skips from authenticated;

-- Totals and status (20261020000200_invoice_write_off.sql), with referral credits off before tax
-- after the discount, in proportion over the taxed and untaxed charges as the discount is. They're
-- never more than what's left after the discount, so the total is never below the tax. A void
-- invoice keeps the charges it was voided with: its credits are given back after it's void, and
-- the record still says what the client was sent.
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
  if new.status <> 'draft' and new.sent_at is null then
    new.sent_at := now();
  end if;
  return new;
end $$;

-- The invoice is in QuickBooks or Zoho Books, or on its way there.
create function private.referral_in_books(p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sync_links l join public.invoices i on i.id = l.local_id and i.company_id = l.company_id
                  where l.local_id = p_invoice and l.entity = 'invoice' and l.provider in ('quickbooks', 'zoho_books'))
      or exists (select 1 from public.outbox o where o.done_at is null and o.dead_at is null and o.topic = 'accounting.invoice'
                  and o.payload ->> 'invoice_id' = p_invoice::text)
$$;

-- Credits on the invoice can still change: it's a draft, awaiting payment or past due, with no
-- payments, and Stripe isn't billing it as it is (made in Stripe, or a bank payment on its way).
create function private.referral_credits_changeable(p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select i.status in ('draft', 'sent', 'overdue')
     and not exists (select 1 from public.payments p where p.invoice_id = i.id)
     and not exists (select 1 from public.stripe_invoices s where s.invoice_id = i.id and (s.origin = 'stripe' or s.status = 'processing'))
  from public.invoices i where i.id = p_invoice
$$;

-- How much more referral credit an invoice can take: what's left of its charges after discounts
-- and the credits already on it, or 0 when it can't take one. It can while its credits can change
-- (above), and it isn't a deposit (the money that secures the job) or a retainage release.
-- p_automatic: a credit going on by itself also waits for an invoice that isn't in QuickBooks or
-- Zoho Books yet (sent there, or on its way), as those keep the total they were sent.
create function private.referral_credit_room(p_invoice uuid, p_automatic boolean default true) returns numeric
language sql stable security definer set search_path = '' as $$
  select case
    when not private.referral_credits_changeable(i.id) or i.kind in ('deposit', 'retainage')
      or (p_automatic and i.status <> 'draft' and private.referral_in_books(i.id))
    then 0
    else greatest(i.subtotal - least(i.discount_amount, greatest(i.subtotal, 0)) - i.credit_amount, 0) end
  from public.invoices i where i.id = p_invoice
$$;

-- What's left of a referral's credit to put on invoices: what was earned, less what was given
-- outside Crewtavo and what's on invoices.
create function private.referral_credit_left(p_referral uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select r.reward_amount - r.given_amount - coalesce((select sum(c.amount) from public.referral_credits c where c.referral_id = r.id), 0)
  from public.referrals r where r.id = p_referral
$$;

-- "Maria" from "Maria Lopez"; a longer name (a business) stays whole.
create function private.referral_friend(p_name text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(case when array_length(regexp_split_to_array(trim(coalesce(p_name, '')), '\s+'), 1) <= 2
                              then split_part(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), ' ', 1)
                              else trim(p_name) end, ''), 'a friend')
$$;

create function private.referral_credit_note(p_name text) returns text
language sql immutable set search_path = '' as $$
  select left('Referral credit: thanks for referring ' || private.referral_friend(p_name), 200)
$$;

-- Puts the client's earned credits on their invoices, oldest credit first: their open draft, then
-- their oldest invoice awaiting payment or past due (referral_credit_room). Invoices someone took
-- the credit off, and ones another transaction is changing right now, are left out. Says how much
-- went on. While it runs, referral_credits_follow leaves the invoices it touches alone.
create function private.apply_referral_credits(p_company uuid, p_client uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  inv record;
  v_left numeric;
  v_room numeric;
  v_put numeric;
  v_total numeric := 0;
  v_was text := coalesce(current_setting('crewtavo.referral_credits', true), '');
begin
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || p_client::text));
  perform set_config('crewtavo.referral_credits', 'on', true);
  for r in
    select id, referred_name from public.referrals
     where company_id = p_company and referrer_client_id = p_client and reward_status = 'earned' and auto_apply
     order by earned_at, id
     for update
  loop
    for inv in
      select i.id from public.invoices i
       where i.company_id = p_company and i.client_id = p_client and i.status in ('draft', 'sent', 'overdue')
         and not exists (select 1 from public.referral_credit_skips s where s.referral_id = r.id and s.invoice_id = i.id)
       order by i.status <> 'draft', i.issued_on, i.number nulls last, i.created_at
       for update of i skip locked
    loop
      -- Read again after each one: the guard and the totals have just run.
      v_left := private.referral_credit_left(r.id);
      exit when v_left is null or v_left <= 0;
      v_room := coalesce(private.referral_credit_room(inv.id, true), 0);
      continue when v_room <= 0;
      v_put := least(v_left, v_room);
      insert into public.referral_credits (company_id, referral_id, invoice_id, amount, note, automatic, created_by)
      values (p_company, r.id, inv.id, v_put, private.referral_credit_note(r.referred_name), true, null)
      on conflict (referral_id, invoice_id) do update set amount = public.referral_credits.amount + excluded.amount;
      v_total := v_total + v_put;
    end loop;
  end loop;
  perform set_config('crewtavo.referral_credits', v_was, true);
  return v_total;
end $$;

-- An invoice's credits as it is now: all of them given back when it's void or now another client's,
-- and the newest cut back while they're more than it can take (a promo or a discount came on since).
-- The caller holds the invoice's client's lock; the client it was moved from is locked here, before
-- their referrals change.
create function private.fit_referral_credits(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_over numeric;
  c record;
  v_other uuid;
begin
  select * into i from public.invoices where id = p_invoice;
  if not found then return; end if;
  for v_other in
    select distinct r.referrer_client_id from public.referral_credits rc join public.referrals r on r.id = rc.referral_id
     where rc.invoice_id = i.id and r.referrer_client_id is distinct from i.client_id
     order by 1
  loop
    perform pg_advisory_xact_lock(hashtext('referral_credit:' || v_other::text));
  end loop;
  delete from public.referral_credits rc using public.referrals r
   where rc.invoice_id = i.id and r.id = rc.referral_id
     and (i.status = 'void' or r.referrer_client_id is distinct from i.client_id);
  loop
    select coalesce((select sum(amount) from public.referral_credits where invoice_id = p_invoice), 0) - x.credit_amount
      into v_over from public.invoices x where x.id = p_invoice;
    exit when v_over is null or v_over <= 0;
    select id, amount into c from public.referral_credits where invoice_id = p_invoice order by created_at desc, id desc limit 1;
    exit when c.id is null;
    if c.amount <= v_over then
      delete from public.referral_credits where id = c.id;
    else
      update public.referral_credits set amount = amount - v_over where id = c.id;
    end if;
  end loop;
end $$;

-- At commit, for each invoice that was made or changed: its credits fit it, and an earned credit of
-- its client's goes on if it has room. It reads the invoice as it is by then, so a new invoice has
-- all its lines, a Stripe import its link to Stripe, and running it more than once changes nothing
-- more. Trouble placing a credit never fails the invoice change: the credit stays earned.
create function private.referral_credits_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.invoices;
begin
  if coalesce(current_setting('crewtavo.referral_credits', true), '') = 'on' then return null; end if;
  select * into i from public.invoices where id = new.id;
  if not found then return null; end if;
  -- A client who has never referred anyone, on an invoice with no credits, has nothing to wait for.
  if not exists (select 1 from public.referral_credits where invoice_id = i.id)
     and not exists (select 1 from public.referrals where company_id = i.company_id and referrer_client_id = i.client_id) then
    return null;
  end if;
  begin
    -- The client's lock before their referrals' rows, as every other path takes them. Checked under
    -- it, so a credit a friend's payment is earning right now is seen once that payment commits.
    perform pg_advisory_xact_lock(hashtext('referral_credit:' || i.client_id::text));
    if not exists (select 1 from public.referral_credits where invoice_id = i.id)
       and not exists (select 1 from public.referrals where company_id = i.company_id and referrer_client_id = i.client_id and reward_status = 'earned' and auto_apply) then
      return null;
    end if;
    perform private.fit_referral_credits(i.id);
    if coalesce(private.referral_credit_room(i.id, true), 0) > 0 then
      perform private.apply_referral_credits(i.company_id, i.client_id);
    end if;
  exception when others then
    raise warning 'Referral credits on invoice % weren''t brought up to date: %', i.id, sqlerrm;
  end;
  return null;
end $$;
create constraint trigger referral_credits_follow after insert or update on public.invoices
  deferrable initially deferred for each row execute function private.referral_credits_follow();

-- Every write to referral_credits, whoever makes it: a credit goes on an invoice of the referrer's
-- that can take it, and never past what was earned. A credit only cut back or taken off always goes
-- through, so a discount saved on that invoice never fails over it.
create function private.referral_credit_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r public.referrals;
  v_other numeric;
  v_increase numeric;
  v_client uuid;
begin
  v_increase := new.amount;
  if tg_op = 'UPDATE' then
    if new.referral_id <> old.referral_id or new.invoice_id <> old.invoice_id or new.company_id <> old.company_id then
      raise exception 'A referral credit stays on its invoice. Take it off and apply it again' using errcode = '22023';
    end if;
    v_increase := new.amount - old.amount;
  end if;
  if v_increase <= 0 then
    return new;
  end if;
  select * into r from public.referrals where id = new.referral_id and company_id = new.company_id for update;
  if not found or r.reward_status not in ('earned', 'applied') then
    raise exception 'This referral has no credit to put on an invoice' using errcode = '22023';
  end if;
  select coalesce(sum(amount), 0) into v_other from public.referral_credits where referral_id = r.id and id <> new.id;
  if v_other + new.amount > r.reward_amount - r.given_amount then
    raise exception 'That''s more than is left of this referral credit' using errcode = '22023';
  end if;
  select client_id into v_client from public.invoices where id = new.invoice_id and company_id = new.company_id;
  if v_client is distinct from r.referrer_client_id then
    raise exception 'A referral credit goes on an invoice of the client who referred their friend' using errcode = '22023';
  end if;
  if coalesce(private.referral_credit_room(new.invoice_id, false), 0) < v_increase then
    raise exception 'This invoice can''t take that much credit' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger referral_credit_guard before insert or update on public.referral_credits
  for each row execute function private.referral_credit_guard();

-- After a credit goes on, changes or comes off: the referral is applied once all of it is on
-- invoices (or given), and earned again otherwise. A credit marked given whose part on an invoice
-- comes off is earned again for that part, so it goes on their next invoice. No credit stays as it
-- is. Then the invoice's totals are worked out again. The referrer's lock comes first, as on every
-- other path (a draft deleted reaches here with nothing else held).
create function private.referral_credit_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_referral uuid;
  v_invoice uuid;
  v_referrer uuid;
begin
  if tg_op = 'DELETE' then
    v_referral := old.referral_id;
    v_invoice := old.invoice_id;
  else
    v_referral := new.referral_id;
    v_invoice := new.invoice_id;
  end if;
  select referrer_client_id into v_referrer from public.referrals where id = v_referral;
  if found then
    perform pg_advisory_xact_lock(hashtext('referral_credit:' || v_referrer::text));
    update public.referrals r
       set reward_status = case when s.total < r.reward_amount - r.given_amount then 'earned' when r.reward_status = 'issued' then 'issued' else 'applied' end,
           applied_at = case when s.total >= r.reward_amount - r.given_amount and r.reward_status <> 'issued' then now() end
      from (select coalesce(sum(amount), 0) as total from public.referral_credits where referral_id = v_referral) s
     where r.id = v_referral and r.reward_status in ('earned', 'applied', 'issued')
       and r.reward_status is distinct from
           case when s.total < r.reward_amount - r.given_amount then 'earned' when r.reward_status = 'issued' then 'issued' else 'applied' end;
  end if;
  update public.invoices set updated_at = now() where id = v_invoice;
  return null;
end $$;
create trigger referral_credit_changed after insert or update or delete on public.referral_credits
  for each row execute function private.referral_credit_changed();

-- A credit given back (its invoice voided or deleted, taken off by hand, or cut back) goes on the
-- referrer's next open invoice, at commit: by then a referral or client being deleted is gone, and
-- nothing is put back on what the same transaction is taking away.
create function private.referral_credit_freed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.referrals;
begin
  if tg_op = 'UPDATE' then
    if new.amount >= old.amount then return null; end if;
  end if;
  select * into r from public.referrals where id = old.referral_id;
  if not found or r.reward_status <> 'earned' or not r.auto_apply then return null; end if;
  begin
    perform private.apply_referral_credits(r.company_id, r.referrer_client_id);
  exception when others then
    raise warning 'Referral credit % wasn''t put on another invoice: %', r.id, sqlerrm;
  end;
  return null;
end $$;
create constraint trigger referral_credit_freed after delete or update on public.referral_credits
  deferrable initially deferred for each row execute function private.referral_credit_freed();

-- ---------------------------------------------------------------------------------------------
-- Earning: the friend pays their first invoice
-- ---------------------------------------------------------------------------------------------

-- The last 10 digits, as the Twilio webhook matches a text to clients (apps/api/src/services/textsOff.ts
-- phoneKey). Email addresses compare by private.email_key (20261025006001_email_sign_in_codes.sql).
create function private.phone_key(p_phone text) returns text
language sql immutable set search_path = '' as $$
  select nullif(right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 10), '')
$$;

-- The friend is the referrer: the same client, or their email address or phone number (its last 10
-- digits, as texts are matched to clients) is the referrer's.
create function private.referral_is_self(p_referrer uuid, p_friend uuid, p_email text, p_phone text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_friend is not distinct from p_referrer and p_friend is not null
      or exists (select 1 from public.clients c where c.id = p_referrer
                  and ((private.email_key(c.email) is not null and private.email_key(c.email) = private.email_key(p_email))
                    or (private.phone_key(c.phone) is not null and private.phone_key(c.phone) = private.phone_key(p_phone))))
$$;

-- The friend was a client already: another client with their email or phone has had work done
-- (a job, or an invoice that isn't void). With p_before (a referral from before, looked at now),
-- only work from before then counts: a job made before it, or an invoice dated before it in the
-- company's time zone, as referral_no_credit counts the friend's own.
create function private.referral_known_client(p_company uuid, p_referrer uuid, p_friend uuid, p_email text, p_phone text, p_before timestamptz default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.clients c
     join public.companies co on co.id = c.company_id
     where c.company_id = p_company and c.id <> p_referrer and c.id is distinct from p_friend
       and ((private.email_key(p_email) is not null and private.email_key(c.email) = private.email_key(p_email))
         or (private.phone_key(p_phone) is not null and private.phone_key(c.phone) = private.phone_key(p_phone)))
       and (exists (select 1 from public.jobs j where j.client_id = c.id and (p_before is null or j.created_at < p_before))
         or exists (select 1 from public.invoices i where i.client_id = c.id and i.status <> 'void'
                     and (p_before is null or i.issued_on < (p_before at time zone coalesce(co.timezone, 'UTC'))::date))))
$$;

-- The friend is this client: the same email address, or the same phone number and name. A phone
-- number alone may be someone else in the household.
create function private.referral_same_person(p_client uuid, p_name text, p_email text, p_phone text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.clients c where c.id = p_client
       and ((private.email_key(c.email) is not null and private.email_key(c.email) = private.email_key(p_email))
         or (private.phone_key(c.phone) is not null and private.phone_key(c.phone) = private.phone_key(p_phone)
             and lower(regexp_replace(trim(c.display_name), '\s+', ' ', 'g')) = lower(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g')))))
$$;

-- Why a referral earns nothing when the friend pays, or null: they referred themselves, or the
-- friend had work with the business before they were referred (a job from before, or an invoice
-- dated before the referral in the company's time zone, as a history import from Stripe brings in).
-- A credit the office gave anyway isn't checked again.
create function private.referral_no_credit(p_referral uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when r.credit_anyway then null
    when private.referral_is_self(r.referrer_client_id, r.referred_client_id, f.email, f.phone) then 'self'
    when exists (select 1 from public.jobs j where j.client_id = r.referred_client_id and j.created_at < r.created_at)
      or exists (select 1 from public.invoices i where i.client_id = r.referred_client_id and i.status <> 'void'
                  and i.issued_on < (r.created_at at time zone coalesce(co.timezone, 'UTC'))::date) then 'already_client'
  end
  from public.referrals r
  join public.companies co on co.id = r.company_id
  left join public.clients f on f.id = r.referred_client_id
  where r.id = p_referral
$$;

-- What a percent credit is a percentage of: the invoice's charges after discounts and credits,
-- before tax. A job's final invoice counts the deposits and progress billing it takes off too, so
-- it's the whole job.
create function private.referral_base(p_invoice uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(i.subtotal - least(i.discount_amount, greatest(i.subtotal, 0)) - i.credit_amount, 0)
       + case when i.kind = 'standard' and i.job_id is not null then coalesce((
           select sum(d.subtotal) from public.invoices d
            where d.job_id = i.job_id and d.kind in ('deposit', 'progress') and d.status <> 'void' and d.id <> i.id), 0) else 0 end
  from public.invoices i where i.id = p_invoice
$$;

-- The friend's invoice p_invoice is paid in full: the referral is won (one that was lost comes back,
-- with the credit lost with it), and earns its credit if it can. It's the first paid invoice that
-- charged something (not a deposit or progress billing: the work isn't done yet). The credit is the
-- amount offered, or the percent of that job rounded to cents, and goes on the referrer's invoices
-- straight away (a credit that can't be placed now stays earned, and the payment still goes
-- through). Then the office hears about it, and Automations can say thanks. True when it earned.
create function private.earn_referral(p_referral uuid, p_invoice uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  r public.referrals;
  i public.invoices;
  v_referrer uuid;
  v_reason text;
  v_base numeric;
  v_amount numeric;
  v_applied numeric;
  v_numbers text;
  v_on_id uuid;
  v_on bigint;
  v_where text;
begin
  select referrer_client_id into v_referrer from public.referrals where id = p_referral;
  if not found then return false; end if;
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || v_referrer::text));
  select * into r from public.referrals where id = p_referral for update;
  if not found then return false; end if;
  select * into i from public.invoices where id = p_invoice;
  if not found or i.status <> 'paid' or i.client_id is distinct from r.referred_client_id then
    return false;
  end if;
  if r.status in ('new', 'quoted', 'lost') or (r.reward_status = 'none' and r.no_reward_reason = 'lost') then
    update public.referrals
       set status = 'won', lost_at = null,
           reward_status = case when reward_status = 'none' and no_reward_reason = 'lost' then 'pending' else reward_status end,
           no_reward_reason = case when reward_status = 'none' and no_reward_reason = 'lost' then null else no_reward_reason end
     where id = r.id
    returning * into r;
  end if;
  if r.reward_status <> 'pending' or i.kind not in ('standard', 'visits') then
    return false;
  end if;

  v_reason := private.referral_no_credit(r.id);
  if v_reason is not null then
    update public.referrals set reward_status = 'none', no_reward_reason = v_reason, status = 'won', lost_at = null where id = r.id;
    return false;
  end if;
  -- History brought in quietly from Stripe isn't news, and doesn't earn.
  if coalesce(current_setting('crewtavo.quiet', true), '') = 'on' then
    return false;
  end if;
  v_base := coalesce(private.referral_base(i.id), 0);
  -- Nothing was charged (a promo or credit covered it all): the next paid invoice is their first.
  if v_base <= 0 then
    return false;
  end if;
  v_amount := case r.reward_kind when 'percent' then round(v_base * r.reward_value / 100, 2) else r.reward_value end;
  if v_amount <= 0 then
    update public.referrals set reward_status = 'none', no_reward_reason = 'not_set', status = 'won', lost_at = null where id = r.id;
    return false;
  end if;
  update public.referrals
     set reward_status = 'earned', reward_amount = v_amount, earned_at = now(), earned_invoice_id = i.id,
         status = 'won', lost_at = null, no_reward_reason = null
   where id = r.id;
  begin
    perform private.apply_referral_credits(r.company_id, r.referrer_client_id);
  exception when others then
    raise warning 'Referral credit % wasn''t put on an invoice: %', r.id, sqlerrm;
  end;
  -- Where it went: all of it, part of it (the rest waits for their next invoice), or none yet.
  select coalesce(sum(c.amount), 0), string_agg('#' || x.number, ', ' order by c.created_at, x.number)
    into v_applied, v_numbers
    from public.referral_credits c join public.invoices x on x.id = c.invoice_id where c.referral_id = r.id;
  select c.invoice_id, x.number into v_on_id, v_on from public.referral_credits c join public.invoices x on x.id = c.invoice_id
   where c.referral_id = r.id order by c.created_at, x.number limit 1;
  v_where := case
    when v_applied >= v_amount then format('It went on %s %s.', case when v_numbers like '%,%' then 'invoices' else 'invoice' end, v_numbers)
    when v_applied > 0 then format('%s went on %s %s, and %s goes on their next one.', private.money(v_applied),
      case when v_numbers like '%,%' then 'invoices' else 'invoice' end, v_numbers, private.money(v_amount - v_applied))
    when (select auto_apply from public.referrals where id = r.id) then 'It goes on their next invoice.'
    else 'It''s kept off invoices until someone applies it.' end;
  -- invoice_id and invoice_number are the referrer's invoice it went on first; friend_invoice_id is the one the friend paid.
  perform private.emit(r.company_id, 'referral.earned', 'client', r.referrer_client_id,
    format('%s earned a %s referral credit: %s paid their first invoice. %s', private.client_name(r.referrer_client_id), private.money(v_amount),
      coalesce(nullif(trim(r.referred_name), ''), private.client_name(r.referred_client_id)), v_where),
    jsonb_build_object('referral_id', r.id, 'friend_name', r.referred_name, 'credit', v_amount, 'applied', v_applied,
      'friend_invoice_id', i.id, 'invoice_id', v_on_id, 'invoice_number', v_on));
  return true;
end $$;

-- Earned whether Marketing is installed or not: the business promised it. Any paid invoice wins the
-- friend's referrals (a deposit too: the job is going ahead); earn_referral says which earn.
create function private.earn_referrals() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select id from public.referrals
     where company_id = new.company_id and referred_client_id = new.client_id
       and (status in ('new', 'quoted', 'lost') or reward_status = 'pending' or (reward_status = 'none' and no_reward_reason = 'lost'))
     order by created_at
  loop
    perform private.earn_referral(r.id, new.id);
  end loop;
  return null;
end $$;
-- After every update, as 20261017000700_status_triggers.sql does: a payment marks an invoice paid
-- in a BEFORE trigger, so "update of status" never sees it.
create trigger earn_referrals after update on public.invoices
  for each row when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function private.earn_referrals();

-- The friend's invoice that earned a credit isn't paid after all (a payment removed, refunded, or a
-- dispute lost). Another paid invoice of theirs that charged something keeps it earned. Otherwise
-- it comes off the referrer's invoices that can still change, and it's pending again, so the
-- friend's next paid invoice earns it. Part of it already used (on a paid invoice, on one someone
-- is changing right now, or given outside Crewtavo) stays where it is: the rest is kept off
-- invoices until the office decides, and the office hears either way.
create function private.unearn_referral(p_referral uuid, p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.referrals;
  v_referrer uuid;
  v_next uuid;
  c record;
  v_used numeric;
  v_used_on bigint;
  v_number bigint;
  v_friend text;
begin
  select referrer_client_id into v_referrer from public.referrals where id = p_referral;
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || v_referrer::text));
  select * into r from public.referrals where id = p_referral for update;
  if not found or r.earned_invoice_id is distinct from p_invoice or r.reward_status not in ('earned', 'applied') then
    return;
  end if;
  select i.id into v_next from public.invoices i
   where i.client_id = r.referred_client_id and i.id <> p_invoice and i.status = 'paid' and i.kind in ('standard', 'visits')
     and coalesce(private.referral_base(i.id), 0) > 0
   order by i.issued_on, i.number limit 1;
  if v_next is not null then
    update public.referrals set earned_invoice_id = v_next where id = r.id;
    return;
  end if;

  v_used := r.given_amount;
  for c in
    select rc.id, rc.amount, rc.invoice_id, i.number from public.referral_credits rc join public.invoices i on i.id = rc.invoice_id
     where rc.referral_id = r.id order by rc.invoice_id
  loop
    perform 1 from public.invoices where id = c.invoice_id for update skip locked;
    if found and private.referral_credits_changeable(c.invoice_id) then
      delete from public.referral_credits where id = c.id;
    else
      v_used := v_used + c.amount;
      v_used_on := coalesce(v_used_on, c.number);
    end if;
  end loop;

  select number into v_number from public.invoices where id = p_invoice;
  v_friend := coalesce(nullif(trim(r.referred_name), ''), private.client_name(r.referred_client_id));
  if v_used <= 0 then
    update public.referrals
       set reward_status = 'pending', reward_amount = 0, earned_at = null, earned_invoice_id = null, applied_at = null
     where id = r.id;
    perform private.emit(r.company_id, 'referral.unpaid', 'client', r.referrer_client_id,
      format('%s''s invoice #%s isn''t paid anymore, so %s''s %s referral credit waits for them to pay again.',
        v_friend, v_number, private.client_name(r.referrer_client_id), private.money(r.reward_amount)),
      jsonb_build_object('referral_id', r.id, 'friend_name', r.referred_name, 'credit', r.reward_amount, 'friend_invoice_id', p_invoice, 'kept', 0));
  else
    update public.referrals set auto_apply = false where id = r.id;
    perform private.emit(r.company_id, 'referral.unpaid', 'client', r.referrer_client_id,
      format('%s''s invoice #%s isn''t paid anymore, but %s of %s''s %s referral credit is used already (%s). Anything left is kept off invoices until you decide.',
        v_friend, v_number, private.money(v_used), private.client_name(r.referrer_client_id), private.money(r.reward_amount),
        case when v_used_on is not null then format('on invoice #%s', v_used_on) else 'given outside Crewtavo' end),
      jsonb_build_object('referral_id', r.id, 'friend_name', r.referred_name, 'credit', r.reward_amount, 'friend_invoice_id', p_invoice, 'kept', v_used));
  end if;
end $$;

-- Taking a credit back never fails the refund or the payment being removed.
create function private.referral_friend_unpaid() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select id from public.referrals where earned_invoice_id = new.id and reward_status in ('earned', 'applied') order by created_at
  loop
    begin
      perform private.unearn_referral(r.id, new.id);
    exception when others then
      raise warning 'Referral credit % wasn''t taken back: %', r.id, sqlerrm;
    end;
  end loop;
  return null;
end $$;
create trigger referral_friend_unpaid after update on public.invoices
  for each row when (old.status = 'paid' and new.status is distinct from 'paid')
  execute function private.referral_friend_unpaid();

-- ---------------------------------------------------------------------------------------------
-- The referral page
-- ---------------------------------------------------------------------------------------------

-- A friend asks for a quote from a client's referral link (POST /api/public/refer/:token): the lead,
-- their property and the request, and the referral with the credit offered now. A friend who is the
-- referrer, or already a client, earns no credit, which the office sees and can overrule. When
-- they're the same person as that client (referral_same_person), the request goes on that client,
-- at an address of theirs that matches or a new one, so the office doesn't get them twice. A match
-- on a phone number alone, or an archived client, is a new lead as before. `new_property` says
-- whether the address needs looking up.
create function public.record_referral(p_company uuid, p_referrer uuid, p_name text, p_email text default null, p_phone text default null,
  p_address jsonb default '{}', p_details text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_referrer public.clients;
  v_kind text;
  v_value numeric;
  v_reason text;
  v_client uuid;
  v_property uuid;
  v_new_property boolean := false;
  v_request uuid;
  v_number bigint;
begin
  select * into v_referrer from public.clients where company_id = p_company and id = p_referrer;
  if not found then
    raise exception 'This referral link isn''t valid anymore.' using errcode = 'P0002';
  end if;
  select t.kind, t.value into v_kind, v_value from public.companies co, private.referral_terms(co.settings) t where co.id = p_company;
  v_reason := case
    when private.referral_is_self(p_referrer, null, p_email, p_phone) then 'self'
    when private.referral_known_client(p_company, p_referrer, null, p_email, p_phone) then 'already_client'
    when coalesce(v_value, 0) <= 0 then 'not_set'
  end;

  if v_reason = 'self' then
    select c.id into v_client from public.clients c
     where c.id = p_referrer and c.status <> 'archived' and private.referral_same_person(c.id, p_name, p_email, p_phone);
  elsif v_reason = 'already_client' then
    select c.id into v_client from public.clients c
     where c.company_id = p_company and c.id <> p_referrer and c.status <> 'archived'
       and private.referral_same_person(c.id, p_name, p_email, p_phone)
       and (exists (select 1 from public.jobs j where j.client_id = c.id)
         or exists (select 1 from public.invoices i where i.client_id = c.id and i.status <> 'void'))
     order by c.created_at, c.id limit 1;
  end if;
  if v_client is null then
    insert into public.clients (company_id, status, display_name, email, phone, lead_source, referred_by)
    values (p_company, 'lead', p_name, nullif(trim(p_email), ''), nullif(trim(p_phone), ''), 'Referral', p_referrer)
    returning id into v_client;
  else
    select p.id into v_property from public.properties p
     where p.client_id = v_client
       and lower(regexp_replace(trim(p.line1), '\s+', ' ', 'g')) = lower(regexp_replace(trim(coalesce(p_address ->> 'line1', '')), '\s+', ' ', 'g'))
     order by p.created_at, p.id limit 1;
  end if;
  if v_property is null then
    insert into public.properties (company_id, client_id, line1, city, postal_code)
    values (p_company, v_client, p_address ->> 'line1', nullif(p_address ->> 'city', ''), nullif(p_address ->> 'postal_code', ''))
    returning id into v_property;
    v_new_property := true;
  end if;
  insert into public.requests (company_id, client_id, property_id, source, title, details, created_by)
  values (p_company, v_client, v_property, 'referral', left('Referral from ' || v_referrer.display_name, 200), p_details, null)
  returning id, number into v_request, v_number;
  insert into public.referrals (company_id, referrer_client_id, referred_client_id, request_id, referred_name,
                                reward_kind, reward_value, reward_status, no_reward_reason)
  values (p_company, p_referrer, v_client, v_request, p_name, coalesce(v_kind, 'amount'), coalesce(v_value, 0),
          case when v_reason is null then 'pending' else 'none' end, v_reason);
  return jsonb_build_object('client_id', v_client, 'property_id', v_property, 'new_property', v_new_property, 'request_id', v_request, 'number', v_number);
end $$;

-- ---------------------------------------------------------------------------------------------
-- The office's part
-- ---------------------------------------------------------------------------------------------

-- The referral, for someone at the office level with this area, or a refusal.
create function private.office_referral(p_referral uuid, p_area text) returns public.referrals
language plpgsql stable security definer set search_path = '' as $$
declare r public.referrals;
begin
  select * into r from public.referrals where id = p_referral;
  if not found or not private.has_role(r.company_id, '{owner,admin,office}') then
    raise exception 'Referral not found' using errcode = 'P0002';
  end if;
  if not private.has_perm(r.company_id, p_area) then
    raise exception 'This needs the % area', case p_area when 'invoices' then 'Invoices' else 'Marketing' end using errcode = '42501';
  end if;
  return r;
end $$;

-- Puts what's left of an earned credit on one of the referrer's open invoices, as much as it can take.
-- Says how much went on. Someone applying it on purpose can put it on an invoice already in
-- QuickBooks or Zoho Books (the page says to change it there too).
create function public.apply_referral_credit(p_referral uuid, p_invoice uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  r public.referrals;
  i public.invoices;
  v_left numeric;
  v_room numeric;
  v_put numeric;
begin
  r := private.office_referral(p_referral, 'invoices');
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || r.referrer_client_id::text));
  select * into r from public.referrals where id = p_referral for update;
  v_left := case when r.reward_status in ('earned', 'applied') then private.referral_credit_left(r.id) else 0 end;
  if v_left <= 0 then
    raise exception 'Nothing is left of this credit to apply' using errcode = '22023';
  end if;
  select * into i from public.invoices where id = p_invoice and company_id = r.company_id for update skip locked;
  if not found then
    if exists (select 1 from public.invoices where id = p_invoice and company_id = r.company_id) then
      raise exception 'Someone is changing this invoice right now. Try again in a moment.' using errcode = '22023';
    end if;
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if i.client_id <> r.referrer_client_id then
    raise exception 'A referral credit goes on an invoice of the client who referred their friend' using errcode = '22023';
  end if;
  v_room := coalesce(private.referral_credit_room(i.id, false), 0);
  if v_room <= 0 and private.referral_credits_changeable(i.id) and i.kind not in ('deposit', 'retainage') then
    raise exception 'Discounts and credits already cover this invoice''s charges, so there''s no room for a credit' using errcode = '22023';
  elsif v_room <= 0 then
    raise exception 'This invoice can''t take a credit: it''s paid, void, a deposit or billed through Stripe' using errcode = '22023';
  end if;
  v_put := least(v_left, v_room);
  delete from public.referral_credit_skips where referral_id = r.id and invoice_id = i.id;
  insert into public.referral_credits (company_id, referral_id, invoice_id, amount, note, automatic)
  values (r.company_id, r.id, i.id, v_put, private.referral_credit_note(r.referred_name), false)
  on conflict (referral_id, invoice_id) do update set amount = public.referral_credits.amount + excluded.amount, automatic = false;
  return v_put;
end $$;

-- Takes a credit off an invoice that isn't paid. It's earned again, and goes on the referrer's next
-- open invoice, never back on this one by itself.
create function public.remove_referral_credit(p_credit uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.referral_credits;
  r public.referrals;
  i public.invoices;
begin
  select * into c from public.referral_credits where id = p_credit;
  if not found then
    raise exception 'That credit isn''t on an invoice anymore' using errcode = 'P0002';
  end if;
  r := private.office_referral(c.referral_id, 'invoices');
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || r.referrer_client_id::text));
  select * into i from public.invoices where id = c.invoice_id for update skip locked;
  if not found then
    raise exception 'Someone is changing this invoice right now. Try again in a moment.' using errcode = '22023';
  end if;
  if not private.referral_credits_changeable(i.id) then
    raise exception 'A credit stays on an invoice once it''s paid, partly paid or being paid' using errcode = '22023';
  end if;
  insert into public.referral_credit_skips (company_id, referral_id, invoice_id) values (c.company_id, c.referral_id, c.invoice_id)
  on conflict do nothing;
  delete from public.referral_credits where id = c.id;
end $$;

-- Apply automatically, or keep it off invoices until someone applies it (p_on false). On again, it
-- goes on the referrer's open invoices now. Says how much went on.
create function public.referral_auto_apply(p_referral uuid, p_on boolean default true) returns numeric
language plpgsql security definer set search_path = '' as $$
declare r public.referrals;
begin
  r := private.office_referral(p_referral, 'invoices');
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || r.referrer_client_id::text));
  update public.referrals set auto_apply = p_on where id = p_referral;
  if not p_on then return 0; end if;
  return private.apply_referral_credits(r.company_id, r.referrer_client_id);
end $$;

-- Given outside Crewtavo ("Given"): what isn't on invoices of an earned credit, or a set amount
-- whose friend hasn't paid yet. given_amount records how much, so a part on an invoice that later
-- comes off is earned again rather than counted as given.
create function public.referral_set_given(p_referral uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.referrals;
begin
  r := private.office_referral(p_referral, 'marketing');
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || r.referrer_client_id::text));
  select * into r from public.referrals where id = p_referral for update;
  if r.reward_status = 'earned' then
    update public.referrals
       set reward_status = 'issued', reward_issued_at = now(),
           given_amount = r.given_amount + greatest(private.referral_credit_left(r.id), 0)
     where id = r.id;
  elsif r.reward_status = 'pending' and r.reward_kind = 'amount' and r.reward_value > 0 then
    update public.referrals
       set reward_status = 'issued', reward_amount = r.reward_value, given_amount = r.reward_value, reward_issued_at = now()
     where id = r.id;
  elsif r.reward_status = 'pending' then
    raise exception 'This credit is worked out when their friend pays their first invoice' using errcode = '22023';
  elsif r.reward_status = 'applied' then
    raise exception 'All of this credit is on invoices already' using errcode = '22023';
  else
    raise exception 'There''s no credit to give for this referral' using errcode = '22023';
  end if;
end $$;

-- No credit for this one, while none of it is on an invoice.
create function public.referral_no_reward(p_referral uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.referrals;
begin
  r := private.office_referral(p_referral, 'marketing');
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || r.referrer_client_id::text));
  select * into r from public.referrals where id = p_referral for update;
  if r.reward_status not in ('pending', 'earned') then
    raise exception 'This referral''s credit can''t be taken away now' using errcode = '22023';
  end if;
  if exists (select 1 from public.referral_credits where referral_id = r.id) then
    raise exception 'Part of this credit is on an invoice. Take it off the invoice first' using errcode = '22023';
  end if;
  if r.given_amount > 0 then
    raise exception 'Part of this credit was given outside Crewtavo already' using errcode = '22023';
  end if;
  update public.referrals set reward_status = 'none', no_reward_reason = 'by_hand' where id = r.id;
end $$;

-- Give a credit anyway: for one that matched the referrer or an existing client (a shared family
-- phone, an old lead), or that someone said no to. It's pending again, or earned at once when the
-- friend has paid already for work from the day they were referred (a client they were matched to
-- has older invoices that don't count).
create function public.referral_give_credit(p_referral uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.referrals;
  v_invoice uuid;
  v_since date;
begin
  r := private.office_referral(p_referral, 'marketing');
  perform pg_advisory_xact_lock(hashtext('referral_credit:' || r.referrer_client_id::text));
  select * into r from public.referrals where id = p_referral for update;
  if r.reward_status <> 'none' or r.no_reward_reason not in ('self', 'already_client', 'by_hand') then
    raise exception 'This referral can''t be given a credit' using errcode = '22023';
  end if;
  if r.reward_value <= 0 then
    raise exception 'This referral was made when no credit was set' using errcode = '22023';
  end if;
  if r.referred_client_id = r.referrer_client_id then
    raise exception 'A client can''t earn a credit for referring themselves' using errcode = '22023';
  end if;
  update public.referrals set reward_status = 'pending', no_reward_reason = null, credit_anyway = true where id = r.id;
  select (r.created_at at time zone coalesce(co.timezone, 'UTC'))::date into v_since from public.companies co where co.id = r.company_id;
  for v_invoice in
    select i.id from public.invoices i where i.client_id = r.referred_client_id and i.status = 'paid' and i.kind in ('standard', 'visits')
       and i.issued_on >= v_since
     order by i.issued_on, i.number
  loop
    exit when private.earn_referral(r.id, v_invoice);
  end loop;
  return (select reward_status from public.referrals where id = r.id);
end $$;

-- What's left of a client's earned credits, for their invoices' "Apply referral credit" and their
-- page, for the office with the Invoices area (who may not have Marketing). The friend by first name.
create function public.referral_credits_for(p_company uuid, p_client uuid)
returns table (referral_id uuid, friend text, friend_name text, credit_left numeric, auto_apply boolean)
language sql stable security definer set search_path = '' as $$
  select r.id, private.referral_friend(r.referred_name), r.referred_name, private.referral_credit_left(r.id), r.auto_apply
  from public.referrals r
  where r.company_id = p_company and r.referrer_client_id = p_client and r.reward_status = 'earned'
    and private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'invoices')
  order by r.earned_at, r.id
$$;

-- A referral whose credit is on an invoice that's gone out stays: the invoice says what it was for.
-- (A draft's credit goes with it.) The server and migrations, deleting a company or a client, go
-- through, as the other delete guards let them.
create function private.referral_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_number bigint;
begin
  if (select auth.uid()) is not null then
    select i.number into v_number from public.referral_credits c join public.invoices i on i.id = c.invoice_id
     where c.referral_id = old.id and i.status <> 'draft' order by i.number limit 1;
    if found then
      raise exception 'This referral''s credit is on invoice #%. Take it off first', v_number using errcode = '22023';
    end if;
  end if;
  return old;
end $$;
create trigger referral_delete_guard before delete on public.referrals
  for each row execute function private.referral_delete_guard();

-- Referral events carry a credit and a friend's name: only the office with Marketing or Invoices
-- reads them, as offer events need the subs area (20261025004001_sub_offers.sql).
create policy activity_referrals on public.activity as restrictive for select to authenticated
  using (not starts_with(verb, 'referral.')
         or (private.has_role(company_id, '{owner,admin,office}') and (private.has_perm(company_id, 'marketing') or private.has_perm(company_id, 'invoices'))));

-- ---------------------------------------------------------------------------------------------
-- Referrals from before
-- ---------------------------------------------------------------------------------------------

-- Referrals as they were, in the new shape. Says how many changed.
--   1. Their terms: the amount they were offered. Given ones were given in full.
--   2. No reward: not set.
--   3. New or quoted ones whose friend has paid an invoice are won (a job made without a quote
--      never moved them on).
--   4. Pending ones whose friend is the referrer, or was a client already when they were referred,
--      earn nothing.
--   5. Pending ones whose friend has paid an invoice that charged something are earned, with that
--      invoice and when it was paid. Given ones stay given.
--   6. Earned credits go on the referrer's open invoices now, as one earned today would.
create function private.backfill_referral_credits() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer := 0;
  v_rows integer;
  r record;
  v_reason text;
  v_invoice public.invoices;
begin
  update public.referrals set reward_value = reward_amount
   where reward_kind = 'amount' and reward_value = 0 and reward_amount > 0 and earned_at is null;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;
  update public.referrals set given_amount = reward_amount
   where reward_status = 'issued' and given_amount = 0 and reward_amount > 0
     and not exists (select 1 from public.referral_credits c where c.referral_id = referrals.id);
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;
  update public.referrals set no_reward_reason = 'not_set' where reward_status = 'none' and no_reward_reason is null;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;
  update public.referrals x set status = 'won'
   where x.status in ('new', 'quoted') and x.referred_client_id is not null
     and exists (select 1 from public.invoices i where i.client_id = x.referred_client_id and i.status = 'paid');
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  for r in
    select x.id, x.company_id, x.referrer_client_id, x.referred_client_id, x.reward_value, x.created_at, f.email, f.phone
      from public.referrals x left join public.clients f on f.id = x.referred_client_id
     where x.reward_status = 'pending' and not x.credit_anyway
  loop
    v_reason := coalesce(private.referral_no_credit(r.id),
      case when private.referral_known_client(r.company_id, r.referrer_client_id, r.referred_client_id, r.email, r.phone, r.created_at) then 'already_client' end);
    if v_reason is not null then
      update public.referrals set reward_status = 'none', no_reward_reason = v_reason where id = r.id;
      v_count := v_count + 1;
      continue;
    end if;
    select i.* into v_invoice from public.invoices i
     where i.client_id = r.referred_client_id and i.status = 'paid' and i.kind in ('standard', 'visits') and coalesce(private.referral_base(i.id), 0) > 0
     order by i.issued_on, i.number limit 1;
    if v_invoice.id is null then continue; end if;
    if r.reward_value > 0 then
      update public.referrals
         set reward_status = 'earned', reward_amount = r.reward_value, status = 'won', earned_invoice_id = v_invoice.id,
             earned_at = coalesce((select max(p.received_at) from public.payments p where p.invoice_id = v_invoice.id), v_invoice.updated_at)
       where id = r.id;
    else
      update public.referrals set reward_status = 'none', no_reward_reason = 'not_set', status = 'won' where id = r.id;
    end if;
    v_count := v_count + 1;
  end loop;

  for r in
    select distinct company_id, referrer_client_id from public.referrals where reward_status = 'earned' and auto_apply
  loop
    begin
      perform private.apply_referral_credits(r.company_id, r.referrer_client_id);
    exception when others then
      raise warning 'Referral credits of client % weren''t put on an invoice: %', r.referrer_client_id, sqlerrm;
    end;
  end loop;
  return v_count;
end $$;
select private.backfill_referral_credits();

-- With every referral in the new shape: a credit that's earned or on invoices has an amount and a
-- date, and no credit says why.
alter table public.referrals
  add constraint referrals_earned_check check (reward_status not in ('earned', 'applied') or (earned_at is not null and reward_amount > 0)),
  add constraint referrals_no_reward_check check (reward_status <> 'none' or no_reward_reason is not null),
  add constraint referrals_given_check check (given_amount >= 0 and given_amount <= reward_amount);

revoke all on function private.referral_defaults(), private.referral_credits_changeable(uuid), private.referral_credit_room(uuid, boolean),
  private.referral_credit_left(uuid), private.referral_in_books(uuid),
  private.referral_friend(text), private.referral_credit_note(text), private.apply_referral_credits(uuid, uuid),
  private.fit_referral_credits(uuid), private.referral_credits_follow(), private.referral_credit_guard(), private.referral_credit_changed(),
  private.referral_credit_freed(), private.phone_key(text), private.referral_is_self(uuid, uuid, text, text),
  private.referral_known_client(uuid, uuid, uuid, text, text, timestamptz), private.referral_same_person(uuid, text, text, text),
  private.referral_no_credit(uuid), private.referral_base(uuid),
  private.earn_referral(uuid, uuid), private.earn_referrals(), private.unearn_referral(uuid, uuid), private.referral_friend_unpaid(),
  private.office_referral(uuid, text), private.referral_delete_guard(), private.backfill_referral_credits() from public;

-- The referral page goes through the server, which checks the link, Turnstile and how often.
revoke execute on function public.record_referral(uuid, uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_referral(uuid, uuid, text, text, text, jsonb, text) to service_role;
revoke execute on function public.apply_referral_credit(uuid, uuid), public.remove_referral_credit(uuid), public.referral_auto_apply(uuid, boolean),
  public.referral_set_given(uuid), public.referral_no_reward(uuid), public.referral_give_credit(uuid), public.referral_credits_for(uuid, uuid) from public, anon;
grant execute on function public.apply_referral_credit(uuid, uuid), public.remove_referral_credit(uuid), public.referral_auto_apply(uuid, boolean),
  public.referral_set_given(uuid), public.referral_no_reward(uuid), public.referral_give_credit(uuid), public.referral_credits_for(uuid, uuid) to authenticated;

-- The policies above check the company the per-row way; rewrite them like the others (see
-- 20261018000990_policy_lookups.sql).
select private.fold_member_checks();

notify pgrst, 'reload schema';
