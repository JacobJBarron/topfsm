-- Asking clients for referrals (docs/marketing-plan.md, phase B), Jobber's way: an email with the
-- client's own referral link, sent by hand from Marketing → Referrals or the client's page, or by a
-- new starter rule a week after a job is completed (off until a business turns it on). Email only,
-- no reminders, and an automatic ask goes to a client at most once every 6 months. Every ask that
-- went counts toward the 6 months, by hand or automatic, as review asks do.
--
-- And the numbers on Marketing → Referrals and Metrics: leads, jobs won, what referred clients have
-- paid, the credits, and the top referrers (referral_stats).

-- ---------------------------------------------------------------------------------------------
-- Asks
-- ---------------------------------------------------------------------------------------------

create table public.referral_asks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid not null,
  automatic boolean not null default false,
  status text not null default 'sent' check (status in ('sent', 'failed')),
  error text check (char_length(error) <= 500),
  sent_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  unique (company_id, id),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade
);
create index referral_asks_client_idx on public.referral_asks (client_id, sent_at desc);
create index referral_asks_company_idx on public.referral_asks (company_id, sent_at desc);
alter table public.referral_asks enable row level security;
create policy referral_asks_read on public.referral_asks for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('referral_asks', 'marketing', true);
-- Only the server records asks.
revoke insert, update, delete on public.referral_asks from authenticated;

-- When the client was last asked for referrals, as the 6 months count it: an ask that went, not one
-- that failed. As the person calling it, so someone signed in learns only what they can read.
create function public.last_referral_ask(p_company uuid, p_client uuid) returns timestamptz
language sql stable security invoker set search_path = '' as $$
  select max(a.sent_at) from public.referral_asks a
   where a.company_id = p_company and a.client_id = p_client and a.status <> 'failed'
$$;
revoke execute on function public.last_referral_ask(uuid, uuid) from public, anon;
grant execute on function public.last_referral_ask(uuid, uuid) to authenticated, service_role;

-- Records an ask before it's sent, or returns null when one went within p_gap_days (automatic asks):
-- two workers asking one client at the same moment ask once. As begin_review_request does
-- (20261030000600_review_ask_followups.sql).
create function public.begin_referral_ask(p_company uuid, p_client uuid, p_automatic boolean, p_gap_days integer default null, p_created_by uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('referral_ask:' || p_client::text));
  if p_gap_days is not null and public.last_referral_ask(p_company, p_client) > now() - make_interval(days => p_gap_days) then
    return null;
  end if;
  insert into public.referral_asks (company_id, client_id, automatic, created_by)
  values (p_company, p_client, coalesce(p_automatic, false), p_created_by)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.begin_referral_ask(uuid, uuid, boolean, integer, uuid) from public, anon, authenticated;
grant execute on function public.begin_referral_ask(uuid, uuid, boolean, integer, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The starter rule
-- ---------------------------------------------------------------------------------------------

-- As in 20261030000500_marketing_stops.sql, with "Ask for referrals after a job": a week after a job
-- is completed, once the review ask (a day after) and its reminders (3 and 5 days after that) are
-- done. Not after recurring work, and off until the business turns it on.
create or replace function private.install_default_automations(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare office jsonb := '["owner", "admin", "office"]';
begin
  insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  values
    (p_company, 'notify_quote_approved', 'Tell the office when a quote is approved',
     'A notification for the office as soon as a client approves.', 'quote.approved', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Quote #{{number}} approved',
       'body', '{{client.name}} approved “{{title}}” ({{total}}).')), true),
    (p_company, 'notify_changes_requested', 'Tell the office when a client asks for changes',
     null, 'quote.changes_requested', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Changes requested on quote #{{number}}',
       'body', '{{client.name}} wants changes to “{{title}}”.')), true),
    (p_company, 'notify_range_accepted', 'Tell the office when a client says yes to a price range',
     'A notification to book the site visit.', 'quote.range_accepted', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', '["owner", "admin", "office", "estimator"]'::jsonb,
       'title', '{{client.name}} wants a visit', 'body', 'They said yes to the price range for “{{title}}”. Book the site visit.')), true),
    (p_company, 'notify_new_request', 'Tell the office about new online requests',
     'Requests from your booking forms and the Client Hub.', 'request.created', 0,
     jsonb_build_array(jsonb_build_object('field', 'source', 'op', 'in', 'value', jsonb_build_array('web_form', 'hub', 'referral'))),
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'New request from {{client.name}}',
       'body', '{{title}}')), true),
    (p_company, 'notify_invoice_paid', 'Tell the office when an invoice is paid',
     null, 'invoice.paid', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Invoice #{{number}} paid',
       'body', '{{client.name}} paid {{total}}.')), true),
    (p_company, 'quote_followup', 'Follow up on quotes after 3 days',
     'Emails the client if they haven''t answered a quote three days after you send it.', 'quote.sent', 4320,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'sent')),
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Following up on your quote from {{company.name}}',
       'body', E'Hi {{client.first_name}},\n\nJust checking whether you had any questions about quote #{{number}} ({{total}}). You can review and approve it here:\n\n{{link}}\n\nThanks,\n{{company.name}}')), true),
    (p_company, 'invoice_overdue', 'Remind clients when an invoice is past due',
     null, 'invoice.overdue', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: invoice #{{number}} from {{company.name}} is past due',
       'body', E'Hi {{client.first_name}},\n\nThis is a friendly reminder that invoice #{{number}} has a balance of {{balance}}. You can view and pay it here:\n\n{{link}}\n\nThank you,\n{{company.name}}')), true),
    (p_company, 'visit_reminder', 'Remind clients the day before a visit',
     'Sent the day before each scheduled visit or assessment.', 'visit.reminder', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: {{company.name}} is coming {{date}}',
       'body', E'Hi {{client.first_name}},\n\nThis is a reminder that {{company.name}} is scheduled to visit {{address}} on {{date}}{{time}}.\n\nQuestions? Reply to this email or call {{company.phone}}.')), false),
    (p_company, 'on_my_way', 'Text the client when the crew is on the way',
     'Sent when a crew taps “On my way” in the app.', 'visit.en_route', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_sms',
       'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now.')), false),
    (p_company, 'review_after_job', 'Ask for a Google review after a job',
     'Sends your review link a day after a job is completed.', 'job.completed', 1440,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'review_recurring', 'Ask for a Google review on recurring work',
     'Sends your review link a day after a recurring job reaches the visit you chose in Marketing, once for each job.', 'job.recurring_third_visit', 1440, '[]',
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'referral_after_job', 'Ask for referrals after a job',
     'Emails your referral link a week after a job is completed.', 'job.completed', 10080,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_referral')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

-- Every business has the new rule, off. Running install_default_automations again would bring back
-- starter rules a business deleted, so only this one is added. Says how many.
create function private.add_referral_rule() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  select c.id, 'referral_after_job', 'Ask for referrals after a job', 'Emails your referral link a week after a job is completed.',
         'job.completed', 10080,
         jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
         jsonb_build_array(jsonb_build_object('type', 'request_referral')), false
    from public.companies c
  on conflict (company_id, template_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.add_referral_rule() from public;
select private.add_referral_rule();

-- ---------------------------------------------------------------------------------------------
-- The numbers
-- ---------------------------------------------------------------------------------------------

-- What referred clients have paid (their paid invoices) before tax, as a percent credit counts it,
-- for referrals made between p_from and p_to. Friends who were the referrer or a client already
-- don't count. Null for someone without the Invoices area, so a missing figure never reads as $0.
create function private.referral_revenue(p_company uuid, p_from timestamptz default null, p_to timestamptz default null) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'invoices') then (
    select coalesce(sum(i.total - i.tax_amount), 0) from public.invoices i
     where i.company_id = p_company and i.status = 'paid'
       and i.client_id in (select r.referred_client_id from public.referrals r
                            where r.company_id = p_company and r.referred_client_id is not null
                              and coalesce(r.no_reward_reason, '') not in ('self', 'already_client')
                              and (p_from is null or r.created_at >= p_from) and (p_to is null or r.created_at < p_to))) end
$$;
revoke all on function private.referral_revenue(uuid, timestamptz, timestamptz) from public;
grant execute on function private.referral_revenue(uuid, timestamptz, timestamptz) to authenticated;

-- Marketing → Referrals and Metrics: referrals made between p_from and p_to (any time, by default)
-- and what came of them. For the office with Marketing; the money referred clients paid needs the
-- Invoices area too (null without it).
--   leads, won              referrals, and those won. A friend who was the referrer or a client
--                           already isn't a lead, or a referral that became a job.
--   revenue                 what referred clients have paid, before tax
--   credits                 pending (set amounts still to be earned, and how many are waiting,
--                           percent ones included), earned (not on invoices yet), applied (on
--                           invoices) and given (outside Crewtavo)
--   top_referrers           up to 5: leads, won and revenue, the most won first
create function public.referral_stats(p_company uuid, p_from timestamptz default null, p_to timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_money boolean;
  v_result jsonb;
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'marketing')) then
    raise exception 'Referrals are part of Marketing' using errcode = '42501';
  end if;
  v_money := private.has_perm(p_company, 'invoices');
  with refs as (
    select r.*, coalesce((select sum(c.amount) from public.referral_credits c where c.referral_id = r.id), 0) as applied,
           coalesce(r.no_reward_reason, '') not in ('self', 'already_client') as lead
      from public.referrals r
     where r.company_id = p_company and (p_from is null or r.created_at >= p_from) and (p_to is null or r.created_at < p_to)
  ), friends as (
    select distinct referrer_client_id, referred_client_id from refs where referred_client_id is not null and lead
  ), paid as (
    select i.client_id, sum(i.total - i.tax_amount) as total from public.invoices i
     where i.company_id = p_company and i.status = 'paid' and i.client_id in (select referred_client_id from friends)
     group by i.client_id
  ), top as (
    select r.referrer_client_id as client_id, count(*) as referrals, count(*) filter (where r.status = 'won') as won,
           (select coalesce(sum(p.total), 0) from paid p where p.client_id in (select f.referred_client_id from friends f where f.referrer_client_id = r.referrer_client_id)) as revenue
      from refs r where r.lead group by r.referrer_client_id
  )
  select jsonb_build_object(
    'leads', (select count(*) from refs where lead),
    'won', (select count(*) from refs where lead and status = 'won'),
    'revenue', case when v_money then (select coalesce(sum(p.total), 0) from paid p) end,
    'credits', jsonb_build_object(
      'pending', (select coalesce(sum(reward_value), 0) from refs where reward_status = 'pending' and reward_kind = 'amount'),
      'pending_count', (select count(*) from refs where reward_status = 'pending'),
      'pending_percent', (select count(*) from refs where reward_status = 'pending' and reward_kind = 'percent'),
      'earned', (select coalesce(sum(reward_amount - given_amount - applied), 0) from refs where reward_status = 'earned'),
      'applied', (select coalesce(sum(applied), 0) from refs),
      'given', (select coalesce(sum(given_amount), 0) from refs)),
    'top_referrers', coalesce((
      select jsonb_agg(jsonb_build_object('client_id', t.client_id, 'name', c.display_name, 'referrals', t.referrals, 'won', t.won,
                                          'revenue', case when v_money then t.revenue end)
                       order by t.won desc, t.revenue desc, t.referrals desc, c.display_name)
        from (select * from top order by won desc, revenue desc, referrals desc limit 5) t
        join public.clients c on c.id = t.client_id), '[]'::jsonb))
  into v_result;
  return v_result;
end $$;
revoke execute on function public.referral_stats(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.referral_stats(uuid, timestamptz, timestamptz) to authenticated;

-- As in 20261030000600_review_ask_followups.sql, with referral credits earned and not on invoices
-- yet (credits_owed, in place of rewards_pending) and what referred clients have paid. Referrals and
-- those won leave out friends who were the referrer or a client already, as referral_stats does.
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
    'opted_out', (select count(*) from public.clients where company_id = p_company_id and marketing_opt_out)
  )
$$;

-- The policies above check the company the per-row way; rewrite them like the others (see
-- 20261018000990_policy_lookups.sql).
select private.fold_member_checks();

notify pgrst, 'reload schema';
