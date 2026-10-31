-- What campaigns bring in (docs/marketing-plan.md, phase C), for one-off and automated campaigns
-- alike: opens (a tracking image), clicks (tracked links) and the work booked after a click.
--
--   Opens     approximate: Apple Mail and some others load images to protect privacy, so an email
--             can show as opened when it wasn't. An open alone isn't a click.
--   Clicks    a tracked link (GET /api/public/c/:token/:n) redirects only to the link stored on the
--             recipient's row. A click counts as an open too. A click in the first 30 seconds after
--             sending, or a HEAD request, is a link scanner's and isn't counted (scanners that click
--             later, like Defender Safe Links, still are).
--   Bookings  a request or an approved quote from someone who clicked a campaign's link in the 30
--             days before, attributed to their latest click. A request and the quote made from it
--             are one booking, and one deleted is gone. Revenue is what that work has been paid,
--             before tax and retainage held back, whenever it's paid; an invoice with no booked work
--             behind it counts when it's paid within 30 days of a click and its work (its job, or the
--             invoice itself) was set up after the click. An invoice that stops being paid loses its
--             revenue.
--
-- Tracked links and pixels work while Marketing is uninstalled: they read no settings.

-- ---------------------------------------------------------------------------------------------
-- Opens and clicks (the server's: the public routes call them)
-- ---------------------------------------------------------------------------------------------

-- An open or a click shows the email went, so one left 'sending' for 15 minutes (its worker sent it
-- but couldn't record that) is recorded sent then, from when it started, and its results count.
create function private.went_unrecorded(r public.campaign_recipients) returns boolean
language sql stable set search_path = '' as $$
  select r.status = 'sending' and r.claimed_at < now() - interval '15 minutes'
$$;

create function public.track_campaign_open(p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.campaign_recipients r
     set opened_at = coalesce(opened_at, now()), open_count = open_count + 1,
         status = 'sent', sent_at = coalesce(sent_at, claimed_at)
   where track_token = p_token and (status = 'sent' or private.went_unrecorded(r));
  return found;
end $$;

-- The link p_n (from 0) of the recipient whose token this is, or null. The click is counted when
-- p_count (not a HEAD request), the email went, and it's been 30 seconds since.
create function public.track_campaign_click(p_token uuid, p_n integer, p_count boolean default true) returns text
language plpgsql security definer set search_path = '' as $$
declare v_row public.campaign_recipients;
begin
  select * into v_row from public.campaign_recipients where track_token = p_token;
  if not found or p_n is null or p_n < 0 or p_n >= cardinality(v_row.links) then
    return null;
  end if;
  if coalesce(p_count, false) and (v_row.status = 'sent' or private.went_unrecorded(v_row))
     and now() - coalesce(v_row.sent_at, v_row.claimed_at) >= interval '30 seconds' then
    update public.campaign_recipients
       set click_count = click_count + 1, clicked_at = coalesce(clicked_at, now()), last_clicked_at = now(),
           open_count = open_count + case when opened_at is null then 1 else 0 end, opened_at = coalesce(opened_at, now()),
           status = 'sent', sent_at = coalesce(sent_at, claimed_at)
     where id = v_row.id;
  end if;
  return v_row.links[p_n + 1];
end $$;
revoke all on function private.went_unrecorded(public.campaign_recipients) from public;
revoke execute on function public.track_campaign_open(uuid), public.track_campaign_click(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.track_campaign_open(uuid), public.track_campaign_click(uuid, integer, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------------------------

-- chain_id is the work a booking is part of: a request's own id; a quote's request, or itself; an
-- invoice's job's quote's chain, or itself. Work that follows a booking goes with it.
create table public.campaign_bookings (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  campaign_id uuid not null,
  recipient_id bigint not null references public.campaign_recipients (id) on delete cascade,
  client_id uuid,
  kind text not null check (kind in ('request', 'quote', 'invoice')),
  record_id uuid not null,
  chain_id uuid not null,
  -- Invoices: total less tax, when paid. Null otherwise.
  amount numeric(12, 2),
  booked_at timestamptz not null default now(),
  unique (company_id, kind, record_id),
  foreign key (company_id, campaign_id) references public.campaigns (company_id, id) on delete cascade,
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete set null (client_id)
);
create index campaign_bookings_campaign_idx on public.campaign_bookings (campaign_id);
create index campaign_bookings_recipient_idx on public.campaign_bookings (recipient_id);
create index campaign_bookings_chain_idx on public.campaign_bookings (company_id, chain_id);
alter table public.campaign_bookings enable row level security;
-- With what was paid in it, for the office with Invoices; campaign_results gives the rest their counts.
create policy campaign_bookings_read on public.campaign_bookings for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'invoices'));
select private.restrict_area('campaign_bookings', 'marketing', true);
revoke insert, update, delete on public.campaign_bookings from authenticated;

-- Records a booking for p_client's record, on the booking it follows (p_chain) or else on their
-- latest counted click in the last 30 days. With p_started (an invoice's work: when its job was
-- made or its quote approved, or the invoice itself), only a click from before that counts: paying
-- for work set up before the click (a recurring job, an old quote's job, an overdue invoice) isn't
-- what the campaign brought in. Nothing for a quiet import (Stripe history) or a client who clicked
-- nothing.
create function private.record_campaign_booking(p_company uuid, p_client uuid, p_kind text, p_record uuid, p_chain uuid,
  p_amount numeric default null, p_started timestamptz default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_recipient bigint;
  v_campaign uuid;
begin
  if coalesce(current_setting('crewtavo.quiet', true), '') = 'on' or p_client is null then
    return;
  end if;
  select b.recipient_id, b.campaign_id into v_recipient, v_campaign
    from public.campaign_bookings b
   where b.company_id = p_company and b.chain_id = p_chain and b.kind in ('request', 'quote')
   order by b.booked_at, b.id limit 1;
  if v_recipient is null then
    select r.id, r.campaign_id into v_recipient, v_campaign
      from public.campaign_recipients r
     where r.company_id = p_company and r.client_id = p_client
       and r.last_clicked_at > now() - interval '30 days' and r.last_clicked_at <= now()
       and (p_started is null or r.clicked_at <= p_started)
     order by r.last_clicked_at desc, r.id desc limit 1;
  end if;
  if v_recipient is null then
    return;
  end if;
  insert into public.campaign_bookings (company_id, campaign_id, recipient_id, client_id, kind, record_id, chain_id, amount)
  values (p_company, v_campaign, v_recipient, p_client, p_kind, p_record, p_chain, p_amount)
  on conflict (company_id, kind, record_id) do nothing;
end $$;

create function private.book_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.record_campaign_booking(new.company_id, new.client_id, 'request', new.id, new.id);
  return null;
end $$;
create trigger campaign_booking after insert on public.requests
  for each row execute function private.book_request();

-- A request or quote deleted (the office's, or its client's) isn't a booking anymore.
create function private.unbook_record() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.campaign_bookings where company_id = old.company_id and kind = tg_argv[0] and record_id = old.id;
  return null;
end $$;
create trigger campaign_booking_gone after delete on public.requests
  for each row execute function private.unbook_record('request');

-- Fires on every update, not "update of status": a status set by another trigger isn't in the
-- statement (20261017000700_status_triggers.sql).
create function private.book_quote() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.record_campaign_booking(new.company_id, new.client_id, 'quote', new.id, coalesce(new.request_id, new.id));
  return null;
end $$;
create trigger campaign_booking after update on public.quotes
  for each row when (new.status in ('approved', 'converted') and old.status not in ('approved', 'converted'))
  execute function private.book_quote();
create trigger campaign_booking_gone after delete on public.quotes
  for each row execute function private.unbook_record('quote');

-- A payment that pays an invoice off sets its status in invoice_totals, so this fires on every
-- update too. Paid: its revenue, before tax. Not paid any more (a payment removed or refunded): gone.
-- Retainage held back isn't paid yet: an invoice books what it charged less its retainage, and the
-- retainage invoice that bills it later books the rest, so a job's revenue is counted once.
create function private.book_invoice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_chain uuid;
  v_started timestamptz;
begin
  if new.status = 'paid' then
    select coalesce(q.request_id, q.id), least(j.created_at, q.approved_at, q.converted_at) into v_chain, v_started
      from public.jobs j left join public.quotes q on q.id = j.quote_id
     where j.id = new.job_id;
    perform private.record_campaign_booking(new.company_id, new.client_id, 'invoice', new.id, coalesce(v_chain, new.id),
      greatest(new.total - new.tax_amount - new.retainage_amount, 0), coalesce(v_started, new.created_at));
  else
    delete from public.campaign_bookings where company_id = new.company_id and kind = 'invoice' and record_id = new.id;
  end if;
  return null;
end $$;
create trigger campaign_booking after update on public.invoices
  for each row when ((new.status = 'paid') is distinct from (old.status = 'paid'))
  execute function private.book_invoice();

create function private.unbook_invoice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.campaign_bookings where company_id = old.company_id and kind = 'invoice' and record_id = old.id;
  return null;
end $$;
create trigger campaign_booking_gone after delete on public.invoices
  for each row execute function private.unbook_invoice();

revoke all on function private.record_campaign_booking(uuid, uuid, text, uuid, uuid, numeric, timestamptz), private.book_request(), private.book_quote(),
  private.book_invoice(), private.unbook_invoice(), private.unbook_record() from public;

-- ---------------------------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------------------------

-- Each campaign's numbers (or p_campaign's), drafts left out, for the office with Marketing:
-- emails sent, how many of those were opened and clicked, bookings (a request and its quote are
-- one) and revenue, which needs the Invoices area too (null without it).
create function public.campaign_results(p_company uuid, p_campaign uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_money boolean;
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'marketing')) then
    raise exception 'Campaign results are part of Marketing' using errcode = '42501';
  end if;
  v_money := private.has_perm(p_company, 'invoices');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'campaign_id', c.id, 'kind', c.kind, 'template_key', c.template_key,
             'sent', coalesce(r.sent, 0), 'opened', coalesce(r.opened, 0), 'clicked', coalesce(r.clicked, 0),
             'bookings', coalesce(b.bookings, 0), 'revenue', case when v_money then coalesce(b.revenue, 0) end)
           order by c.created_at desc)
      from public.campaigns c
      left join lateral (
        select count(*) filter (where x.status = 'sent') as sent,
               count(*) filter (where x.status = 'sent' and x.opened_at is not null) as opened,
               count(*) filter (where x.status = 'sent' and x.clicked_at is not null) as clicked
          from public.campaign_recipients x where x.campaign_id = c.id) r on true
      left join lateral (
        select count(distinct y.chain_id) filter (where y.kind in ('request', 'quote')) as bookings,
               sum(y.amount) filter (where y.kind = 'invoice') as revenue
          from public.campaign_bookings y where y.campaign_id = c.id) b on true
     where c.company_id = p_company and c.status <> 'draft' and (p_campaign is null or c.id = p_campaign)), '[]'::jsonb);
end $$;
revoke execute on function public.campaign_results(uuid, uuid) from public, anon;
grant execute on function public.campaign_results(uuid, uuid) to authenticated;

-- Who a campaign went to, newest first, a page at a time, with what each one opened, clicked and
-- booked: { total, recipients: [...] }. The same checks as campaign_results.
create function public.campaign_recipient_results(p_campaign uuid, p_limit integer default 100, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid;
  v_money boolean;
begin
  select company_id into v_company from public.campaigns where id = p_campaign;
  if v_company is null or not (private.has_role(v_company, '{owner,admin,office}') and private.has_perm(v_company, 'marketing')) then
    raise exception 'Campaign results are part of Marketing' using errcode = '42501';
  end if;
  v_money := private.has_perm(v_company, 'invoices');
  return jsonb_build_object(
    'total', (select count(*) from public.campaign_recipients where campaign_id = p_campaign),
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'client_id', r.client_id, 'name', r.name, 'email', r.email, 'status', r.status, 'error', r.error,
               'sent_at', r.sent_at, 'opened_at', r.opened_at, 'clicked_at', r.clicked_at,
               'open_count', r.open_count, 'click_count', r.click_count,
               'quote_number', (select q.number from public.quotes q where q.id = r.subject_id),
               'bookings', (select count(distinct b.chain_id) from public.campaign_bookings b where b.recipient_id = r.id and b.kind in ('request', 'quote')),
               'revenue', case when v_money then (select coalesce(sum(b.amount), 0) from public.campaign_bookings b where b.recipient_id = r.id and b.kind = 'invoice') end)
             order by r.id desc)
        from (select * from public.campaign_recipients x where x.campaign_id = p_campaign
               order by x.id desc limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) r), '[]'::jsonb));
end $$;
revoke execute on function public.campaign_recipient_results(uuid, integer, integer) from public, anon;
grant execute on function public.campaign_recipient_results(uuid, integer, integer) to authenticated;

-- As in 20261031000120_referral_asks.sql, with what campaigns brought in (campaign_revenue: paid
-- invoices before tax, null without the Invoices area). Emails sent count automated ones too.
create or replace function public.marketing_summary(p_company_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'campaigns_sent', (select count(*) from public.campaigns where company_id = p_company_id and status = 'sent'),
    'emails_sent_30d', (select count(*) filter (where r.status = 'sent') from public.campaign_recipients r
                         where r.company_id = p_company_id and r.sent_at > now() - interval '30 days'),
    'reviews_requested_30d', (select count(*) from public.review_requests
                               where company_id = p_company_id and sent_at > now() - interval '30 days'
                                 and status <> 'failed' and (channel <> 'link' or clicked_at is not null)),
    'reviews_clicked_30d', (select count(*) from public.review_requests
                             where company_id = p_company_id and sent_at > now() - interval '30 days' and clicked_at is not null),
    'referrals_total', (select count(*) from public.referrals where company_id = p_company_id
                         and coalesce(no_reward_reason, '') not in ('self', 'already_client')),
    'referrals_won', (select count(*) from public.referrals where company_id = p_company_id and status = 'won'
                       and coalesce(no_reward_reason, '') not in ('self', 'already_client')),
    'credits_owed', (select coalesce(sum(r.reward_amount - r.given_amount - coalesce((select sum(c.amount) from public.referral_credits c where c.referral_id = r.id), 0)), 0)
                       from public.referrals r where r.company_id = p_company_id and r.reward_status = 'earned'),
    'referral_revenue', private.referral_revenue(p_company_id),
    'campaign_revenue', case when private.has_role(p_company_id, '{owner,admin,office}') and private.has_perm(p_company_id, 'invoices') then
                          (select coalesce(sum(b.amount), 0) from public.campaign_bookings b where b.company_id = p_company_id and b.kind = 'invoice') end,
    'opted_out', (select count(*) from public.clients where company_id = p_company_id and marketing_opt_out)
  )
$$;

select private.fold_member_checks();

notify pgrst, 'reload schema';
