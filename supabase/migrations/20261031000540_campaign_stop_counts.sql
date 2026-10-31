-- A one-off campaign stopped partway says what went ("Stopped · 3 of 10 sent", docs/marketing-plan.md,
-- decision 3), however it was stopped and whenever:
--
--   Every stop       a campaign's sent and failed counts are taken from its recipients as it's marked
--                    cancelled (private.campaign_stop_counts): Stop on the campaign's page, and
--                    uninstalling Marketing while it sends (marketing_set_enabled), which wrote no
--                    counts. The sender still writes them again if an email that was out finishes.
--   Stopped before   campaigns stopped before the sender wrote counts whatever the status kept the
--                    counts of their last batch (often 0 of 10): they're counted again now
--                    (private.backfill_stopped_campaign_counts).

-- A campaign's sent and failed recipients.
create function private.campaign_counts(p_campaign uuid, out sent integer, out failed integer)
language sql stable security definer set search_path = '' as $$
  select count(*) filter (where r.status = 'sent')::integer, count(*) filter (where r.status = 'failed')::integer
    from public.campaign_recipients r
   where r.campaign_id = p_campaign
$$;

-- As a campaign is marked cancelled: its counts, from its recipients.
create function private.campaign_stop_counts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select c.sent, c.failed into new.sent_count, new.failed_count from private.campaign_counts(new.id) c;
  return new;
end $$;
create trigger campaign_stop_counts before update of status on public.campaigns
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function private.campaign_stop_counts();

-- One-off campaigns already stopped, counted again from their recipients. Says how many changed.
create function private.backfill_stopped_campaign_counts() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.campaigns c
     set sent_count = n.sent, failed_count = n.failed
    from public.campaigns s cross join lateral private.campaign_counts(s.id) n
   where s.id = c.id and c.kind = 'one_off' and c.status = 'cancelled'
     and (c.sent_count, c.failed_count) is distinct from (n.sent, n.failed);
  get diagnostics v_count = row_count;
  return v_count;
end $$;
select private.backfill_stopped_campaign_counts();

revoke all on function private.campaign_counts(uuid), private.campaign_stop_counts(), private.backfill_stopped_campaign_counts() from public;

notify pgrst, 'reload schema';
