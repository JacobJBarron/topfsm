-- AI assistants (Claude, ChatGPT over MCP) can be given three more areas (packages/core/src/assistants.ts
-- has them): the estimate templates and contract terms that estimates and invoices print with;
-- campaigns, review and referral asks, Google review replies and social posts; and promo codes. A
-- discount is money, so "Full access, no money" leaves promo codes out, and its refusal says so.
--
-- The database checks every Data API write an assistant makes as before
-- (20261019002000_assistant_more_areas.sql): the table has to be in an area its connection may change.
-- What the server writes for the marketing tools (campaign recipients, review replies, social posts)
-- the tools check, with the same rules (apps/api/src/mcp.ts). None of it takes or charges a payment.

alter table public.assistant_connections drop constraint assistant_connections_areas_check;
alter table public.assistant_connections add constraint assistant_connections_areas_check
  check (areas <@ array['clients', 'records', 'jobs', 'schedule', 'time', 'quotes', 'invoices', 'pay',
    'company', 'prices', 'crews', 'checklists', 'booking', 'guides', 'automations', 'team',
    'templates', 'marketing', 'promos']);

create or replace function private.assistant_table_area(p_table text) returns text
language sql immutable set search_path = '' as $$
  select case p_table
    when 'clients' then 'clients'
    when 'client_contacts' then 'clients'
    when 'properties' then 'clients'
    when 'property_access' then 'clients'
    when 'requests' then 'records'
    when 'messages' then 'records'
    when 'jobs' then 'jobs'
    when 'job_line_items' then 'jobs'
    when 'visits' then 'schedule'
    when 'visit_assignees' then 'schedule'
    when 'visit_equipment' then 'schedule'
    when 'routes' then 'schedule'
    when 'time_entries' then 'time'
    when 'quotes' then 'quotes'
    when 'quote_line_items' then 'quotes'
    when 'quote_options' then 'quotes'
    when 'invoices' then 'invoices'
    when 'invoice_line_items' then 'invoices'
    when 'payments' then 'invoices'
    when 'pay_periods' then 'pay'
    when 'pay_period_lines' then 'pay'
    when 'companies' then 'company'
    when 'services' then 'prices'
    when 'crews' then 'crews'
    when 'crew_members' then 'crews'
    when 'checklist_templates' then 'checklists'
    when 'intake_forms' then 'booking'
    when 'sop_pages' then 'guides'
    when 'sop_categories' then 'guides'
    when 'automation_rules' then 'automations'
    when 'memberships' then 'team'
    when 'company_roles' then 'team'
    when 'document_templates' then 'templates'
    when 'contract_sections' then 'templates'
    when 'campaigns' then 'marketing'
    when 'promo_codes' then 'promos'
  end
$$;

/** Quotes, invoices and payments, pay, and promo codes: what full access without money leaves out. */
create or replace function private.assistant_money_area(p_area text) returns boolean
language sql immutable set search_path = '' as $$
  select p_area in ('quotes', 'invoices', 'pay', 'promos')
$$;

-- As in 20261019002000_assistant_more_areas.sql, with the new areas' refusals.
create or replace function hooks.before_request() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_method text := current_setting('request.method', true);
  v_path text := coalesce(current_setting('request.path', true), '');
  v_table text := ltrim(v_path, '/');
  v_area text;
  v_level text;
  -- Taking someone off a crew or a visit, or a machine off a visit, is a change, not deleting.
  v_delete boolean := v_method = 'DELETE' and ltrim(v_path, '/') not in ('crew_members', 'visit_assignees', 'visit_equipment');
begin
  if private.assistant_client() is null then return; end if;
  if v_method in ('GET', 'HEAD') then
    perform set_config('transaction_read_only', 'on', true);
    return;
  end if;
  if v_path like '/rpc/%' then
    -- A function that writes for its area, or one that answers but can't write.
    v_area := private.assistant_rpc_area(substr(v_path, 6));
    if v_area is null or not private.assistant_may_change(v_area, false) then
      perform set_config('transaction_read_only', 'on', true);
    end if;
    return;
  end if;
  v_area := private.assistant_table_area(v_table);
  if v_area is not null and private.assistant_may_change(v_area, v_delete) then return; end if;
  select a.level into v_level from public.assistant_connections a
  where a.user_id = (select auth.uid()) and a.client_id = private.assistant_client();
  raise exception using errcode = 'PT403', message = case
    when v_area is null then 'An AI assistant can''t change this. Do it in Crewtavo itself.'
    when v_level = 'full_no_money' and private.assistant_money_area(v_area) then
      'This assistant can''t change money: quotes, invoices, payments, pay or promo codes. To let it, give it Full access in Crewtavo, under Settings → AI assistants.'
    when v_delete and v_level = 'areas' then
      'This assistant can''t delete things. Only an assistant with full access can, in Crewtavo, under Settings → AI assistants.'
    else format('This assistant can''t change %s. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.', case v_area
      when 'clients' then 'clients and properties' when 'records' then 'requests and notes' when 'jobs' then 'jobs'
      when 'schedule' then 'the schedule' when 'time' then 'clocks and timesheets' when 'quotes' then 'quotes'
      when 'invoices' then 'invoices and payments' when 'pay' then 'pay' when 'company' then 'company details'
      when 'prices' then 'the price list' when 'crews' then 'crews' when 'checklists' then 'checklists'
      when 'booking' then 'booking forms' when 'guides' then 'guides' when 'team' then 'people and roles'
      when 'templates' then 'estimate templates and contract terms' when 'marketing' then 'campaigns, reviews and social posts'
      when 'promos' then 'promo codes' else 'automations' end)
  end;
end $$;
