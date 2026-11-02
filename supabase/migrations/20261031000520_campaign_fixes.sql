-- Follow-ups to automated campaigns (docs/marketing-plan.md, decision 3), from checking them end to end:
--
--   A busy email service   an automated campaign email Resend turns away for sending too many at
--                          once (429, or it's having trouble: 5xx) isn't a failure: its run waits
--                          and tries again, 1, 2, 4 and then 8 minutes later, and fails only after
--                          that (automation_runs.busy_tries, postpone_automation_run's p_busy). The
--                          run keeps its place, so a re-engage client stays queued and counted.
--   Emails waiting         a card's "N emails waiting" (automated_campaign_states) and the question
--                          before turning Close pending quotes or Win back off count only runs that
--                          would still send: the quote still as the rule's status condition asks
--                          (awaiting a response, or lost), not one approved, converted or lost since
--                          (private.campaign_waiting).

-- ---------------------------------------------------------------------------------------------
-- A busy email service
-- ---------------------------------------------------------------------------------------------

alter table public.automation_runs add column busy_tries integer not null default 0 check (busy_tries >= 0);
comment on column public.automation_runs.busy_tries is 'Times the run waited because the email service was busy (429 or 5xx); it fails after a few';

-- As in 20261030000300_review_reminders.sql, and p_busy counts a wait for a busy email service.
drop function public.postpone_automation_run(bigint, uuid, timestamptz, jsonb, text);
create function public.postpone_automation_run(p_id bigint, p_token uuid, p_until timestamptz, p_result jsonb, p_note text default null, p_busy boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.automation_runs
     set status = 'pending', run_after = greatest(p_until, now()), result = coalesce(p_result, result), error = left(p_note, 1000),
         attempts = greatest(attempts - 1, 0), locked_until = null, claim_token = null,
         busy_tries = busy_tries + case when coalesce(p_busy, false) then 1 else 0 end
   where id = p_id and status = 'running' and claim_token = p_token;
  return found;
end $$;
revoke execute on function public.postpone_automation_run(bigint, uuid, timestamptz, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.postpone_automation_run(bigint, uuid, timestamptz, jsonb, text, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Emails waiting
-- ---------------------------------------------------------------------------------------------

-- The status a rule's conditions ask for ("its status is …"), lowercased, or null when it asks none.
create function private.wanted_status(p_conditions jsonb) returns text
language sql immutable set search_path = '' as $$
  select lower(trim(c ->> 'value'))
    from jsonb_array_elements(case when jsonb_typeof(p_conditions) = 'array' then p_conditions else '[]'::jsonb end) c
   where c ->> 'field' = 'status' and c ->> 'op' = 'equals' and jsonb_typeof(c -> 'value') = 'string'
   limit 1
$$;

-- A rule's runs still waiting that would send: a quote's only while the quote is still there and
-- has the status the rule asks for (Close pending quotes: awaiting a response; Win back: lost), as
-- the engine checks when the run comes due. Others (Re-engage's clients) as they are.
create function private.campaign_waiting(p_rule uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select count(*)
    from public.automation_runs ar
    join public.automation_rules r on r.id = ar.rule_id
    left join public.quotes q on ar.subject_type = 'quote' and q.company_id = ar.company_id and q.id = ar.subject_id
   where ar.rule_id = p_rule and ar.status = 'pending'
     and (ar.subject_type is distinct from 'quote'
          or (q.id is not null and (private.wanted_status(r.conditions) is null or lower(q.status) = private.wanted_status(r.conditions))))
$$;
revoke all on function private.campaign_waiting(uuid) from public;

-- As in 20261031000200_automated_campaigns.sql, with only the emails that would still send waiting.
create or replace function public.automated_campaign_states(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'marketing')) then
    raise exception 'Campaigns are part of Marketing' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'template_key', r.template_key, 'rule_id', r.id, 'enabled', r.enabled,
             'days', case when r.trigger = 'client.inactive' then private.inactive_days(r.conditions)
                          when r.delay_minutes > 0 and r.delay_minutes % 1440 = 0 then r.delay_minutes / 1440 end,
             'waiting', private.campaign_waiting(r.id))
           order by r.template_key)
      from public.automation_rules r
     where r.company_id = p_company and r.template_key in ('reengage_past_clients', 'win_back_lost_quotes', 'quote_followup')), '[]'::jsonb);
end $$;

notify pgrst, 'reload schema';
