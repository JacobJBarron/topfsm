-- Lost referrals (docs/marketing-plan.md, phase B). A referral is lost when the friend's request is
-- archived, or their quote is marked lost and they have nothing else open with the business (a
-- quote, a job or an invoice). Its credit goes with it, unless it was earned already. The work can
-- come back: a quote sent or approved, the request restored or an invoice paid brings the referral
-- back, and it can still be won and earn its credit. A friend who has had work done (an invoice
-- paid, a job completed) isn't lost.

-- The friend has something open: a quote not yet lost or archived (other than p_except_quote), a job
-- still going, or an invoice not paid or void.
create function private.referral_open_work(p_client uuid, p_except_quote uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.quotes q where q.client_id = p_client and q.status in ('draft', 'sent', 'changes_requested', 'approved')
                  and q.id is distinct from p_except_quote)
      or exists (select 1 from public.jobs j where j.client_id = p_client and j.status in ('active', 'requires_invoicing'))
      or exists (select 1 from public.invoices i where i.client_id = p_client and i.status in ('draft', 'sent', 'partially_paid', 'overdue'))
$$;

-- The friend has had work done: an invoice paid, or a job completed. Their referral was won, not lost.
create function private.referral_had_work(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invoices i where i.client_id = p_client and i.status = 'paid')
      or exists (select 1 from public.jobs j where j.client_id = p_client and j.status = 'completed')
$$;

-- The friend's referrals (p_client's, or those made with request p_request) that are new or quoted
-- and have nothing open, and no work done, are lost. A credit still to come goes with them; one
-- earned stays.
create function private.referral_mark_lost(p_company uuid, p_client uuid, p_request uuid, p_except_quote uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.referrals r
     set status = 'lost', lost_at = now(),
         reward_status = case when r.reward_status = 'pending' then 'none' else r.reward_status end,
         no_reward_reason = case when r.reward_status = 'pending' then 'lost' else r.no_reward_reason end
   where r.company_id = p_company and r.status in ('new', 'quoted')
     and ((p_client is not null and r.referred_client_id = p_client) or (p_request is not null and r.request_id = p_request))
     and (r.referred_client_id is null
          or not (private.referral_open_work(r.referred_client_id, p_except_quote) or private.referral_had_work(r.referred_client_id)));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The friend's referrals that were lost come back, to where the friend's work is now: won with an
-- approved quote, quoted with one sent, new otherwise. A credit lost with them is still to come.
create function private.referral_revive(p_company uuid, p_client uuid, p_request uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.referrals r
     set status = case
           when exists (select 1 from public.quotes q where q.client_id = r.referred_client_id and q.status in ('approved', 'converted')) then 'won'
           when exists (select 1 from public.quotes q where q.client_id = r.referred_client_id and q.status in ('sent', 'changes_requested')) then 'quoted'
           else 'new' end,
         lost_at = null,
         reward_status = case when r.reward_status = 'none' and r.no_reward_reason = 'lost' then 'pending' else r.reward_status end,
         no_reward_reason = case when r.reward_status = 'none' and r.no_reward_reason = 'lost' then null else r.no_reward_reason end
   where r.company_id = p_company and r.status = 'lost'
     and ((p_client is not null and r.referred_client_id = p_client) or (p_request is not null and r.request_id = p_request));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- As in 20261017000300_marketing.sql (the trigger is 20261017000700_status_triggers.sql's, after
-- every update): a referral advances as the friend's quotes do, a lost one comes back when a quote
-- is sent or approved, and a quote marked lost loses the referral when nothing else is open.
create or replace function private.referral_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if new.status in ('approved', 'converted') then
      update public.referrals
         set status = 'won', lost_at = null,
             reward_status = case when reward_status = 'none' and no_reward_reason = 'lost' then 'pending' else reward_status end,
             no_reward_reason = case when reward_status = 'none' and no_reward_reason = 'lost' then null else no_reward_reason end
       where company_id = new.company_id and referred_client_id = new.client_id and status in ('new', 'quoted', 'lost');
    elsif new.status = 'sent' then
      update public.referrals
         set status = 'quoted', lost_at = null,
             reward_status = case when reward_status = 'none' and no_reward_reason = 'lost' then 'pending' else reward_status end,
             no_reward_reason = case when reward_status = 'none' and no_reward_reason = 'lost' then null else no_reward_reason end
       where company_id = new.company_id and referred_client_id = new.client_id and status in ('new', 'lost');
    elsif new.status = 'lost' then
      perform private.referral_mark_lost(new.company_id, new.client_id, null, new.id);
    end if;
  end if;
  return null;
end $$;

-- The friend's request archived loses its referral (when nothing else is open), and restored
-- brings it back.
create function private.referral_request_archived() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'archived' and old.status is distinct from 'archived' then
    perform private.referral_mark_lost(new.company_id, null, new.id, null);
  elsif old.status = 'archived' and new.status <> 'archived' then
    perform private.referral_revive(new.company_id, null, new.id);
  end if;
  return null;
end $$;
-- After every update, as 20261017000700_status_triggers.sql does.
create trigger referral_request_archived after update on public.requests
  for each row when (new.status is distinct from old.status) execute function private.referral_request_archived();

-- Referrals from before: lost now if their request is archived, or their friend's quote was lost,
-- and the friend has nothing open. Says how many.
create function private.backfill_lost_referrals() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer := 0;
  r record;
begin
  for r in
    select x.company_id, x.referred_client_id, x.request_id from public.referrals x
     where x.status in ('new', 'quoted')
       and (exists (select 1 from public.requests q where q.id = x.request_id and q.status = 'archived')
         or exists (select 1 from public.quotes q where q.client_id = x.referred_client_id and q.status = 'lost'))
  loop
    v_count := v_count + private.referral_mark_lost(r.company_id, r.referred_client_id, r.request_id, null);
  end loop;
  return v_count;
end $$;
select private.backfill_lost_referrals();

revoke all on function private.referral_open_work(uuid, uuid), private.referral_had_work(uuid), private.referral_mark_lost(uuid, uuid, uuid, uuid),
  private.referral_revive(uuid, uuid, uuid), private.referral_request_archived(), private.backfill_lost_referrals() from public;

notify pgrst, 'reload schema';
