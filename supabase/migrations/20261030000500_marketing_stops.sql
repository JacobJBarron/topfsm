-- Follow-ups to Crewtavo - Marketing (20261030000200_marketing_app.sql to
-- 20261030000400_recurring_review_visits.sql), so that what stops stays stopped:
--
--   Campaigns       Uninstalling puts scheduled campaigns back to drafts, as Unschedule does, and
--                   stops ones sending where they are, as Stop does. Before, they waited, and went
--                   out the minute Marketing was installed again, however late.
--   Reminders       counted right before they go (start_review_reminder, in place of
--                   renew_review_reminder), so one that went but wasn't recorded after can't go
--                   again; and reminders stopped while a worker had one (Uninstall, a newer ask)
--                   stay stopped, with the note saying why.
--   STOP            read from old messages exactly as the Twilio webhook reads a new one
--                   (packages/core/src/marketing.ts smsKeyword), whatever the database's locale:
--                   "STOP 🛑" is a STOP in both. STOPs from before are read again.
--   Recurring work  "Ask for a Google review after a job" leaves recurring jobs to the recurring
--                   rule, a recurring job marked complete at the end of its season included, as
--                   the form's other choices do.

-- ---------------------------------------------------------------------------------------------
-- Uninstalling stops campaigns
-- ---------------------------------------------------------------------------------------------

-- As in 20261017000300_marketing.sql, and Uninstall (marketing_set_enabled) goes through.
create or replace function private.campaign_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) = 'authenticated' and not private.marketing_setting() then
    if tg_op = 'DELETE' then
      if old.status in ('sending') then
        raise exception 'A campaign can''t be deleted while it''s sending' using errcode = '22023';
      end if;
      return old;
    end if;
    if old.status <> 'draft' then
      raise exception 'Only draft campaigns can be edited' using errcode = '22023';
    end if;
    if new.status <> 'draft' or new.sent_count <> old.sent_count or new.recipients_count <> old.recipients_count then
      raise exception 'Use Send or Schedule to send a campaign' using errcode = '22023';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- As in 20261030000200_marketing_app.sql. Uninstalling also puts scheduled campaigns back to
-- drafts with their audience to be taken again (POST /api/campaigns/:id/cancel does the same), and
-- stops ones sending, their recipients still to go skipped: installing again doesn't send them late.
create or replace function public.marketing_set_enabled(p_company uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_stopped uuid[];
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can install Marketing' using errcode = '42501';
  end if;
  perform set_config('crewtavo.marketing', 'on', true);
  update public.companies
     set settings = jsonb_set(coalesce(settings, '{}'), '{marketing}',
       (case when jsonb_typeof(settings -> 'marketing') = 'object' then settings -> 'marketing' else '{}'::jsonb end)
         || jsonb_build_object('enabled', p_enabled, 'changed_at', now()))
   where id = p_company;
  if not p_enabled then
    update public.review_requests
       set next_reminder_at = null, reminder_note = 'Marketing was uninstalled'
     where company_id = p_company and next_reminder_at is not null;
    delete from public.campaign_recipients r
     using public.campaigns cp
     where cp.id = r.campaign_id and cp.company_id = p_company and cp.status = 'scheduled';
    update public.campaigns set status = 'draft', scheduled_at = null, recipients_count = 0
     where company_id = p_company and status = 'scheduled';
    -- Stopped first: a run partway through its batch checks this before each email.
    with stopped as (
      update public.campaigns set status = 'cancelled', finished_at = now()
       where company_id = p_company and status = 'sending'
      returning id)
    select coalesce(array_agg(id), '{}') into v_stopped from stopped;
    update public.campaign_recipients set status = 'skipped', error = 'Marketing was uninstalled'
     where campaign_id = any (v_stopped) and status in ('pending', 'sending');
  end if;
  perform set_config('crewtavo.marketing', '', true);
  return p_enabled;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Reminders: counted before they go, and stops that stay
-- ---------------------------------------------------------------------------------------------

drop function public.renew_review_reminder(uuid, uuid);

-- Right before sending: true if the worker still holds the reminder and it's still to go (nobody
-- opened the link, and nothing stopped the reminders since the claim). It's counted now, with p_next
-- as when the one after is due, and the claim is held five more minutes for finish_review_reminder.
create function public.start_review_reminder(p_id uuid, p_token uuid, p_next timestamptz default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.review_requests
     set reminders_sent = reminders_sent + 1, last_reminder_at = now(), next_reminder_at = p_next, reminder_note = null,
         reminder_locked_until = now() + interval '5 minutes'
   where id = p_id and reminder_claim = p_token and clicked_at is null and next_reminder_at is not null;
  return found;
end $$;

-- How a reminder went, if the worker still holds it. sent and failed come after
-- start_review_reminder, which counted it and set when the next is due, so failed only says why.
-- stop ends them, with p_note saying why; later moves this one to p_next. A link opened, or
-- reminders stopped some other way while the worker had it, stay stopped, with what stopped them.
create or replace function public.finish_review_reminder(p_id uuid, p_token uuid, p_outcome text, p_next timestamptz default null, p_note text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'stop', 'later') then
    raise exception 'A reminder is sent, failed, stop or later' using errcode = '22023';
  end if;
  update public.review_requests
     set next_reminder_at = case
           when p_outcome = 'stop' or clicked_at is not null or next_reminder_at is null then null
           when p_outcome = 'later' then p_next
           else next_reminder_at end,
         reminder_note = case
           when p_outcome = 'stop' then coalesce(case when next_reminder_at is null then reminder_note end, left(p_note, 500))
           when p_outcome = 'failed' then coalesce(reminder_note, left(p_note, 500))
           else reminder_note end,
         reminder_claim = null, reminder_locked_until = null
   where id = p_id and reminder_claim = p_token;
  return found;
end $$;

revoke execute on function public.start_review_reminder(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.start_review_reminder(uuid, uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- STOP, read the same everywhere
-- ---------------------------------------------------------------------------------------------

-- As packages/core/src/marketing.ts smsKeyword reads a text: 'stop', 'start' or null. The whole
-- message is the word, in any case, with spaces before it and anything but a letter or digit after
-- it. Ranges, spaces named one by one and translate() read only ASCII, so no locale changes it.
create or replace function private.sms_keyword(p_body text) returns text
language sql immutable set search_path = '' as $$
  select case
    when w in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT', 'REVOKE') then 'stop'
    when w in ('START', 'UNSTOP', 'YES') then 'start'
  end
  from (select translate(
          regexp_replace(regexp_replace(regexp_replace(coalesce(p_body, ''), '^[ \t\n\r\f\v]+', ''), '[^A-Za-z0-9]+$', ''), '[ \t\n\r\f\v]+', ' ', 'g'),
          'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') as w) x
$$;

-- STOPs from before, read again: a STOP with an emoji after it now counts.
select private.backfill_sms_opt_outs();

-- ---------------------------------------------------------------------------------------------
-- Recurring work waits for its own rule
-- ---------------------------------------------------------------------------------------------

-- The starter rule as it came, or as Marketing → Reviews wrote it for "A job is completed", leaves
-- recurring jobs out from now. One someone gave conditions of their own keeps them. Says how many.
create function private.leave_recurring_to_its_rule() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.automation_rules
     set conditions = '[{"field": "kind", "op": "not_equals", "value": "recurring"}]'
   where template_key = 'review_after_job' and trigger = 'job.completed' and conditions = '[]';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.leave_recurring_to_its_rule() from public;
select private.leave_recurring_to_its_rule();

-- As in 20261030000400_recurring_review_visits.sql, with review_after_job leaving recurring jobs out.
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
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

notify pgrst, 'reload schema';
