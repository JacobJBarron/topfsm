-- Automated campaigns, after a look at them in a running instance (docs/marketing-plan.md, phase C):
--
--   Re-engage's other conditions  A Re-engage rule changed in Automations ("Client tags include vip")
--                                 is counted, queued and let go with all its conditions, not only its
--                                 days, so the card's count, the turn-on question and the server's
--                                 refusal say who it would really email, and clients its conditions
--                                 leave out don't use up the day's 100 or their stretch.
--   A quote is recent contact     A client sent a quote (or one marked lost) in the last 6 months isn't
--                                 re-engaged: a recent quote isn't "a while", and Win back looks after
--                                 lost ones, so nobody gets both at once.
--   Starter emails                Re-engage and Win back read well for a business with no phone: the
--                                 phone moves under the company's name, where an empty one leaves no gap.
--   Results                       Who got a campaign can be narrowed to those who opened, clicked or
--                                 booked; Marketing's overview says how many emails were automated.
--   Audience choices              Each city and service says how many clients it has.

-- ---------------------------------------------------------------------------------------------
-- A Re-engage rule's conditions, as the automation engine checks them
-- ---------------------------------------------------------------------------------------------

-- A number as JavaScript's Number() reads text: blank is 0, anything else not a number is null (NaN).
create function private.js_number(p text) returns numeric
language sql immutable set search_path = '' as $$
  select case when p is null then null
              when trim(p) = '' then 0
              when trim(p) ~ '^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]{1,3})?$' then trim(p)::numeric
         end
$$;

-- Whether a client meets a client.inactive rule's conditions, as the engine checks them on the run
-- (packages/core/src/automations.ts checkCondition, with the facts services/automations.ts gives a
-- client): their status, tags and lead source, and p_days since their last visit. Its "days since
-- their last visit is at least" conditions with a number are left out: the caller picks p_days to
-- meet them (private.inactive_days), or, for the card's count at another N, in their place.
create function private.client_conditions_hold(p_conditions jsonb, p_status text, p_tags text[], p_lead_source text, p_days integer)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  c jsonb;
  v_field text;
  v_op text;
  v_value jsonb;
  -- The fact as JavaScript's String() writes it, null when a client has none.
  v_raw text;
  -- The fact as a list (tags), null when it isn't one.
  v_have text[];
  v_want text;
  v_wants text[];
  v_hit boolean;
begin
  for c in select x from jsonb_array_elements(case when jsonb_typeof(p_conditions) = 'array' then p_conditions else '[]'::jsonb end) x loop
    v_field := c ->> 'field';
    v_op := c ->> 'op';
    v_value := c -> 'value';
    continue when v_field = 'days_since_visit' and v_op = 'gte' and (v_value #>> '{}') ~ '^ *[0-9]+(\.[0-9]+)? *$';
    v_have := case when v_field = 'client.tags' then array(select lower(trim(t)) from unnest(coalesce(p_tags, '{}')) t) end;
    v_raw := case v_field
      when 'status' then p_status
      when 'client.status' then p_status
      when 'client.lead_source' then p_lead_source
      when 'client.tags' then array_to_string(coalesce(p_tags, '{}'), ',')
      when 'days_since_visit' then p_days::text
    end;
    v_want := lower(trim(case jsonb_typeof(v_value)
      when 'array' then coalesce((select string_agg(x, ',') from jsonb_array_elements_text(v_value) x), '')
      when 'null' then ''
      else coalesce(v_value #>> '{}', '') end));
    select coalesce(array_agg(w), '{}') into v_wants from (
      select lower(trim(x)) as w from jsonb_array_elements_text(case when jsonb_typeof(v_value) = 'array' then v_value else '[]'::jsonb end) x
      union all
      select lower(trim(x)) from regexp_split_to_table(case when jsonb_typeof(v_value) = 'array' then '' else coalesce(v_value #>> '{}', '') end, ',') x
    ) l where w <> '';
    v_hit := case v_op
      when 'equals' then lower(trim(coalesce(v_raw, ''))) = v_want
      when 'not_equals' then lower(trim(coalesce(v_raw, ''))) <> v_want
      when 'in' then lower(trim(coalesce(v_raw, ''))) = any (v_wants)
      when 'includes' then coalesce(v_have, '{}') && v_wants
      when 'excludes' then not (coalesce(v_have, '{}') && v_wants)
      when 'contains' then case when v_have is not null then exists (select 1 from unnest(v_have) h where strpos(h, v_want) > 0)
                                else strpos(lower(trim(coalesce(v_raw, ''))), v_want) > 0 end
      when 'gte' then private.js_number(coalesce(v_raw, '0')) >= private.js_number(case jsonb_typeof(v_value) when 'array' then v_want when 'null' then '0' else v_value #>> '{}' end)
      when 'lte' then private.js_number(coalesce(v_raw, '0')) <= private.js_number(case jsonb_typeof(v_value) when 'array' then v_want when 'null' then '0' else v_value #>> '{}' end)
      else false
    end;
    if not coalesce(v_hit, false) then
      return false;
    end if;
  end loop;
  return true;
end $$;

-- As in 20261031000200_automated_campaigns.sql, and a client sent a quote in the last 6 months, or
-- one marked lost then, is left out too: a recent quote isn't "a while", and Win back looks after a
-- lost one (its wait is at most 180 days), so a client isn't re-engaged on top of it.
create or replace function private.inactive_clients(p_company uuid, p_days integer, p_now timestamptz)
returns table (client_id uuid, last_visit_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with zone as (
    select coalesce(timezone, 'UTC') as tz, (p_now at time zone coalesce(timezone, 'UTC'))::date as today
      from public.companies where id = p_company
  ), last as (
    select x.client_id, max(x.completed_at) as last_visit_at from (
      select j.client_id, v.completed_at from public.visits v join public.jobs j on j.id = v.job_id
       where v.company_id = p_company and v.status = 'completed' and v.kind in ('job', 'assessment') and v.completed_at is not null
      union all
      select q.client_id, v.completed_at from public.visits v join public.requests q on q.id = v.request_id
       where v.company_id = p_company and v.job_id is null and v.status = 'completed' and v.kind in ('job', 'assessment') and v.completed_at is not null
    ) x group by x.client_id
  )
  select l.client_id, l.last_visit_at
    from last l join public.clients c on c.id = l.client_id cross join zone z
   where c.company_id = p_company
     and (l.last_visit_at at time zone z.tz)::date <= z.today - p_days
     and (l.last_visit_at at time zone z.tz)::date >= z.today - 1095
     and c.status <> 'archived' and not c.marketing_opt_out
     and c.email is not null and trim(c.email) ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     and not exists (
       select 1 from public.jobs j
        where j.client_id = c.id and j.status = 'active'
          and (j.kind = 'recurring'
               or not exists (select 1 from public.visits v where v.job_id = j.id and v.status = 'completed' and v.kind in ('job', 'assessment'))))
     and not exists (
       select 1 from public.visits v
         left join public.jobs j on j.id = v.job_id
         left join public.requests q on q.id = v.request_id
        where v.company_id = p_company and coalesce(j.client_id, q.client_id) = c.id
          and v.kind <> 'task' and v.status in ('unscheduled', 'scheduled', 'en_route', 'in_progress')
          and coalesce(v.scheduled_on, (v.starts_at at time zone z.tz)::date, z.today) >= z.today)
     and not exists (select 1 from public.requests q where q.client_id = c.id and q.status in ('new', 'assessment_scheduled', 'assessment_complete'))
     and not exists (
       select 1 from public.quotes q
        where q.client_id = c.id
          and (q.status = 'approved'
               or (q.status in ('sent', 'changes_requested')
                   and coalesce(q.valid_until, (coalesce(q.sent_at, q.updated_at) at time zone z.tz)::date + 30) >= z.today)))
     and not exists (
       select 1 from public.quotes q
        where q.client_id = c.id and q.status <> 'draft'
          and greatest(q.sent_at, case when q.status = 'lost' then q.updated_at end) > p_now - interval '182 days')
$$;

-- The clients a client.inactive rule emails at p_days without a visit: inactive_clients, less those
-- its other conditions leave out.
create function private.inactive_rule_clients(p_company uuid, p_conditions jsonb, p_days integer, p_now timestamptz)
returns table (client_id uuid, last_visit_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.client_id, i.last_visit_at
    from private.inactive_clients(p_company, p_days, p_now) i
    join public.clients c on c.id = i.client_id
    cross join (select coalesce(timezone, 'UTC') as tz from public.companies where id = p_company) z
   where private.client_conditions_hold(p_conditions, c.status, c.tags, c.lead_source,
           (p_now at time zone z.tz)::date - (i.last_visit_at at time zone z.tz)::date)
$$;
revoke all on function private.js_number(text), private.client_conditions_hold(jsonb, text, text[], text, integer),
  private.inactive_rule_clients(uuid, jsonb, integer, timestamptz) from public;

-- As in 20261031000200_automated_campaigns.sql, with the rule's other conditions (only clients it
-- would email are queued), and a run the engine skipped doesn't count against the day's 100: the cap
-- is for emails.
create or replace function public.emit_inactive_clients(p_now timestamptz default now(), p_cap integer default 100, p_company uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_rule record;
  v_room integer;
  v_campaign uuid;
  v_n integer;
  v_count integer := 0;
begin
  for v_rule in
    select r.id, r.company_id, r.conditions, coalesce(co.timezone, 'UTC') as tz
      from public.automation_rules r join public.companies co on co.id = r.company_id
     where r.enabled and r.trigger = 'client.inactive'
       and co.settings -> 'marketing' ->> 'enabled' = 'true'
       and (p_company is null or r.company_id = p_company)
       and extract(hour from p_now at time zone coalesce(co.timezone, 'UTC')) between 10 and 16
     order by r.id
  loop
    -- Two servers at once queue a rule's clients once.
    perform pg_advisory_xact_lock(hashtext('inactive:' || v_rule.id::text));
    select greatest(0, coalesce(p_cap, 100) - count(*))::integer into v_room
      from public.inactive_client_marks m join public.automation_runs ar on ar.id = m.run_id
     where m.rule_id = v_rule.id and ar.status not in ('cancelled', 'skipped')
       and m.emitted_at >= ((p_now at time zone v_rule.tz)::date)::timestamp at time zone v_rule.tz
       and m.emitted_at < ((p_now at time zone v_rule.tz)::date + 1)::timestamp at time zone v_rule.tz;
    continue when v_room = 0;
    select id into v_campaign from public.campaigns where company_id = v_rule.company_id and template_key = 'reengage_past_clients';
    with picked as materialized (
      select i.client_id, i.last_visit_at
        from private.inactive_rule_clients(v_rule.company_id, v_rule.conditions, private.inactive_days(v_rule.conditions), p_now) i
       where not exists (select 1 from public.inactive_client_marks m
                          where m.rule_id = v_rule.id and m.client_id = i.client_id and m.last_visit_at = i.last_visit_at)
         and not exists (select 1 from public.campaign_recipients cr
                          where cr.campaign_id = v_campaign and cr.client_id = i.client_id
                            and cr.status in ('sent', 'sending') and coalesce(cr.sent_at, cr.claimed_at) > p_now - interval '182 days')
       order by i.last_visit_at desc, i.client_id
       limit v_room
    ), queued as (
      insert into public.automation_runs (company_id, rule_id, subject_type, subject_id, run_after)
      select v_rule.company_id, v_rule.id, 'client', p.client_id, p_now from picked p
      returning id, subject_id
    )
    insert into public.inactive_client_marks (company_id, rule_id, client_id, last_visit_at, run_id, emitted_at)
    select v_rule.company_id, v_rule.id, q.subject_id, p.last_visit_at, q.id, p_now
      from queued q join picked p on p.client_id = q.subject_id
    on conflict (rule_id, client_id, last_visit_at) do update set run_id = excluded.run_id, emitted_at = excluded.emitted_at;
    get diagnostics v_n = row_count;
    v_count := v_count + v_n;
  end loop;
  return v_count;
end $$;

-- As in 20261031000200_automated_campaigns.sql: only the clients the rule would email are marked.
create or replace function public.skip_inactive_backlog(p_rule uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_rule record;
  v_count integer;
begin
  select id, company_id, conditions into v_rule from public.automation_rules where id = p_rule and trigger = 'client.inactive';
  if not found then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtext('inactive:' || v_rule.id::text));
  insert into public.inactive_client_marks (company_id, rule_id, client_id, last_visit_at, run_id)
  select v_rule.company_id, v_rule.id, i.client_id, i.last_visit_at, null
    from private.inactive_rule_clients(v_rule.company_id, v_rule.conditions, private.inactive_days(v_rule.conditions), now()) i
  on conflict (rule_id, client_id, last_visit_at) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- As in 20261031000200_automated_campaigns.sql, with the rule's other conditions: the card, the
-- question on turning it on and the server's refusal count only clients it would email. p_days
-- stands in for its days.
create or replace function public.inactive_client_count(p_company uuid, p_days integer) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rule record;
  v_campaign uuid;
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'marketing')) then
    raise exception 'Campaigns are part of Marketing' using errcode = '42501';
  end if;
  select id, enabled, conditions into v_rule from public.automation_rules where company_id = p_company and template_key = 'reengage_past_clients';
  select id into v_campaign from public.campaigns where company_id = p_company and template_key = 'reengage_past_clients';
  return (
    select count(*) from private.inactive_rule_clients(p_company, coalesce(v_rule.conditions, '[]'::jsonb), greatest(30, coalesce(p_days, 365)), now()) i
     where not exists (select 1 from public.inactive_client_marks m
                        where m.rule_id = v_rule.id and m.client_id = i.client_id and m.last_visit_at = i.last_visit_at
                          and (m.run_id is not null or v_rule.enabled))
       and not exists (select 1 from public.campaign_recipients cr
                        where cr.campaign_id = v_campaign and cr.client_id = i.client_id
                          and cr.status in ('sent', 'sending') and coalesce(cr.sent_at, cr.claimed_at) > now() - interval '182 days'));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Starter emails that read well without a phone
-- ---------------------------------------------------------------------------------------------

-- As in 20261031000200_automated_campaigns.sql, with Re-engage's and Win back's emails asking for a
-- reply, and the phone under the company's name: a business with no phone gets no "or call ." gap.
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
     jsonb_build_array(jsonb_build_object('type', 'request_referral')), false),
    (p_company, 'reengage_past_clients', 'Re-engage past clients',
     'Emails clients a year after their last visit, once each time they go quiet.', 'client.inactive', 0,
     jsonb_build_array(jsonb_build_object('field', 'days_since_visit', 'op', 'gte', 'value', 365)),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
       'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr just reply to this email and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false),
    (p_company, 'win_back_lost_quotes', 'Win back lost quotes',
     'Emails the client 30 days after a quote is marked lost, if it still is.', 'quote.lost', 43200,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'lost')),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'Still thinking about {{title}}?',
       'body', E'Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn''t right, or you''d like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email and we''ll take another look.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

-- As in 20261031000200_automated_campaigns.sql, with the new wording, for a business it gives the two rules to later.
create or replace function private.add_campaign_rules() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  select r.* from public.companies c cross join lateral (values
    (c.id, 'reengage_past_clients', 'Re-engage past clients',
     'Emails clients a year after their last visit, once each time they go quiet.', 'client.inactive', 0,
     jsonb_build_array(jsonb_build_object('field', 'days_since_visit', 'op', 'gte', 'value', 365)),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
       'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr just reply to this email and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false),
    (c.id, 'win_back_lost_quotes', 'Win back lost quotes',
     'Emails the client 30 days after a quote is marked lost, if it still is.', 'quote.lost', 43200,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'lost')),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'Still thinking about {{title}}?',
       'body', E'Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn''t right, or you''d like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email and we''ll take another look.\n\nThanks,\n{{company.name}}\n{{company.phone}}')), false)
  ) r(company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  on conflict (company_id, template_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Rules still sending the first wording get the new one. A rule whose email a business changed keeps it.
update public.automation_rules r
   set actions = n.actions
  from (values
    ('reengage_past_clients',
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
       'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr reply to this email or call {{company.phone}} and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}')),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
       'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr just reply to this email and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}\n{{company.phone}}'))),
    ('win_back_lost_quotes',
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'Still thinking about {{title}}?',
       'body', E'Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn''t right, or you''d like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email or call {{company.phone}}.\n\nThanks,\n{{company.name}}')),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'Still thinking about {{title}}?',
       'body', E'Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn''t right, or you''d like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email and we''ll take another look.\n\nThanks,\n{{company.name}}\n{{company.phone}}')))
  ) n(template_key, old_actions, actions)
 where r.template_key = n.template_key and r.actions = n.old_actions;

-- ---------------------------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------------------------

-- As in 20261031000220_campaign_results.sql, and p_filter narrows it to those who opened, clicked or
-- booked ('opened', 'clicked', 'booked'; anything else is everyone), with total the narrowed count,
-- so the one who booked isn't on page three of a hundred.
drop function public.campaign_recipient_results(uuid, integer, integer);
create function public.campaign_recipient_results(p_campaign uuid, p_limit integer default 100, p_offset integer default 0, p_filter text default 'all') returns jsonb
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
  return (
    with picked as (
      select x.* from public.campaign_recipients x
       where x.campaign_id = p_campaign
         and case coalesce(p_filter, 'all')
               when 'opened' then x.status = 'sent' and x.opened_at is not null
               when 'clicked' then x.status = 'sent' and x.clicked_at is not null
               when 'booked' then exists (select 1 from public.campaign_bookings b where b.recipient_id = x.id)
               else true
             end
    )
    select jsonb_build_object(
      'total', (select count(*) from picked),
      'recipients', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', r.id, 'client_id', r.client_id, 'name', r.name, 'email', r.email, 'status', r.status, 'error', r.error,
                 'sent_at', r.sent_at, 'opened_at', r.opened_at, 'clicked_at', r.clicked_at,
                 'open_count', r.open_count, 'click_count', r.click_count,
                 'quote_number', (select q.number from public.quotes q where q.id = r.subject_id),
                 'bookings', (select count(distinct b.chain_id) from public.campaign_bookings b where b.recipient_id = r.id and b.kind in ('request', 'quote')),
                 'revenue', case when v_money then (select coalesce(sum(b.amount), 0) from public.campaign_bookings b where b.recipient_id = r.id and b.kind = 'invoice') end)
               order by r.id desc)
          from (select * from picked order by id desc
                 limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) r), '[]'::jsonb)));
end $$;
revoke execute on function public.campaign_recipient_results(uuid, integer, integer, text) from public, anon;
grant execute on function public.campaign_recipient_results(uuid, integer, integer, text) to authenticated;

-- As in 20261031000220_campaign_results.sql, and how many of the 30 days' emails were automated
-- campaigns' (automated_sent_30d), so the overview can say where they came from.
create or replace function public.marketing_summary(p_company_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'campaigns_sent', (select count(*) from public.campaigns where company_id = p_company_id and status = 'sent'),
    'emails_sent_30d', (select count(*) filter (where r.status = 'sent') from public.campaign_recipients r
                         where r.company_id = p_company_id and r.sent_at > now() - interval '30 days'),
    'automated_sent_30d', (select count(*) from public.campaign_recipients r join public.campaigns c on c.id = r.campaign_id
                            where r.company_id = p_company_id and c.kind = 'automated' and r.status = 'sent' and r.sent_at > now() - interval '30 days'),
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

-- ---------------------------------------------------------------------------------------------
-- Audience choices with how many clients each has
-- ---------------------------------------------------------------------------------------------

-- As in 20261031000210_campaign_audiences.sql, with count the clients who have each city (from a
-- property or their billing address) or service, each client once.
create or replace function public.campaign_audience_choices(p_company uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with cities as (
    select client_id, trim(city) as label from public.properties where company_id = p_company and trim(coalesce(city, '')) <> ''
    union all
    select id, trim(billing_address ->> 'city') from public.clients
     where company_id = p_company and trim(coalesce(billing_address ->> 'city', '')) <> ''
  ), services as (
    select j.client_id, trim(coalesce(s.name, l.name)) as label
      from public.job_line_items l
      join public.jobs j on j.id = l.job_id
      left join public.services s on s.id = l.service_id
     where l.company_id = p_company and trim(coalesce(s.name, l.name, '')) <> ''
       and (j.status in ('requires_invoicing', 'completed')
            or exists (select 1 from public.visits v where v.job_id = j.id and v.status = 'completed'))
  ), city_counts as (
    select lower(label) as value, mode() within group (order by label) as label, count(distinct client_id)::integer as n
      from cities group by lower(label)
  ), service_counts as (
    select lower(label) as value, mode() within group (order by label) as label, count(distinct client_id)::integer as n
      from services group by lower(label)
  )
  select jsonb_build_object(
    'cities', coalesce((
      select jsonb_agg(jsonb_build_object('value', value, 'label', label, 'count', n) order by n desc, label)
        from (select * from city_counts order by n desc, value limit 200) t), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object('value', value, 'label', label, 'count', n) order by n desc, label)
        from (select * from service_counts order by n desc, value limit 200) t), '[]'::jsonb))
$$;

select private.fold_member_checks();

notify pgrst, 'reload schema';
