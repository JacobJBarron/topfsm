-- Review asks for recurring work. "A job is completed" fires when a job moves to requires
-- invoicing or completed, which a recurring job (weekly mowing, a cleaning contract) never does:
-- it stays active while its visits come and go. So the starter rule "Ask for a Google review after
-- a job" never asked those clients, and switching it to "A visit is completed" would ask them
-- every month.
--
-- A recurring job now has an event of its own, job.recurring_third_visit, when its third visit is
-- done: far enough in that the client has seen the work, and once for each job, however many
-- visits follow. A job that already had three visits before this has it at its next one. A new
-- starter rule, review_recurring, asks for a review a day after it. Businesses that already ask
-- automatically after jobs get it switched on, by the same channel; everyone else has it off, as
-- they have the job one.

-- ---------------------------------------------------------------------------------------------
-- The event
-- ---------------------------------------------------------------------------------------------

create or replace function private.activity_visits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_job record;
begin
  if new.status is distinct from old.status and new.status in ('en_route', 'in_progress', 'completed') then
    v_client := private.visit_client(new);
    perform private.emit(new.company_id,
      case new.status when 'completed' then 'visit.completed' when 'in_progress' then 'visit.started' else 'visit.en_route' end,
      'visit', new.id,
      format('%s: %s%s',
        case new.status when 'completed' then 'Visit completed' when 'in_progress' then 'Visit started' else 'On the way' end,
        new.title, case when v_client is null then '' else ' (' || private.client_name(v_client) || ')' end),
      jsonb_build_object('kind', new.kind, 'client_id', v_client));
  end if;

  -- A recurring job's third visit done, once for each job. Assessments, tasks and events on it
  -- aren't visits of the work. Cheapest first: a one-off job's visits stop at the job, and a
  -- recurring job's after its third at the activity it already has, before anything is counted.
  if new.status = 'completed' and old.status is distinct from 'completed' and new.kind = 'job' and new.job_id is not null then
    select j.id, j.number, j.client_id into v_job from public.jobs j where j.id = new.job_id and j.kind = 'recurring';
    if found then
      -- Two visits finished at the same moment both count to three; only one of them says so.
      perform pg_advisory_xact_lock(hashtext('job.recurring_third_visit:' || v_job.id::text));
      if not exists (select 1 from public.activity a
                      where a.subject_type = 'job' and a.subject_id = v_job.id and a.verb = 'job.recurring_third_visit')
         and (select count(*) from public.visits v where v.job_id = v_job.id and v.kind = 'job' and v.status = 'completed') >= 3 then
        perform private.emit(new.company_id, 'job.recurring_third_visit', 'job', v_job.id,
          format('Job #%s for %s has had its third visit', v_job.number, private.client_name(v_job.client_id)),
          jsonb_build_object('number', v_job.number));
      end if;
    end if;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- The starter rule
-- ---------------------------------------------------------------------------------------------

-- Businesses that ask after jobs now ask on recurring work too, by the channel they chose.
insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
select c.id, 'review_recurring', 'Ask for a Google review on recurring work',
  'Sends your review link a day after a recurring job''s third visit, once for each job.', 'job.recurring_third_visit', 1440, '[]',
  jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', coalesce(
    (select a ->> 'channel' from jsonb_array_elements(r.actions) a where a ->> 'type' = 'request_review' limit 1), 'email'))),
  coalesce(r.enabled, false)
from public.companies c
left join public.automation_rules r on r.company_id = c.id and r.template_key = 'review_after_job'
on conflict (company_id, template_key) do nothing;

-- New businesses get it with the other starter rules (20261023001000_roofing_estimates, plus this one).
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
     'Sends your review link a day after a job is completed.', 'job.completed', 1440, '[]',
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'review_recurring', 'Ask for a Google review on recurring work',
     'Sends your review link a day after a recurring job''s third visit, once for each job.', 'job.recurring_third_visit', 1440, '[]',
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

notify pgrst, 'reload schema';
