-- Recover lease-less zombie runs that stay status=running after a chained HITL
-- pause during approval continuation. Those paths clear the run lease before
-- parking on the next approval; if the park step fails or an older build leaves
-- status=running, recover_expired_agent_runs previously ignored them forever.

create or replace function public.recover_expired_agent_runs(
  p_owner_id uuid,
  p_thread_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  stale public.agent_runs;
  recovered integer := 0;
begin
  perform public.assert_service_scope(p_owner_id);
  for stale in
    select *
    from public.agent_runs
    where owner_id = p_owner_id
      and (p_thread_id is null or thread_id = p_thread_id)
      and status in ('queued', 'running')
      and (
        (lease_expires_at is not null and lease_expires_at <= now())
        or (
          lease_expires_at is null
          and coalesce(heartbeat_at, started_at, now() - interval '1 day')
            <= now() - interval '2 minutes'
        )
      )
    for update skip locked
  loop
    update public.agent_runs
    set
      status = case when cancel_requested_at is null then 'failed' else 'cancelled' end,
      error = case when cancel_requested_at is null then 'run_interrupted' else null end,
      completed_at = now(),
      lease_token = null,
      lease_expires_at = null
    where owner_id = p_owner_id and id = stale.id;

    if stale.assistant_message_id is not null then
      update public.agent_messages
      set
        status = case when stale.cancel_requested_at is null then 'failed' else 'cancelled' end,
        error = case when stale.cancel_requested_at is null then 'run_interrupted' else null end
      where owner_id = p_owner_id and id = stale.assistant_message_id;
    end if;

    update public.agent_threads
    set
      status = case when stale.cancel_requested_at is null then 'failed' else 'idle' end,
      updated_at = now()
    where owner_id = p_owner_id
      and id = stale.thread_id
      and not exists (
        select 1
        from public.agent_runs active
        where active.owner_id = p_owner_id
          and active.thread_id = stale.thread_id
          and active.id <> stale.id
          and active.status in ('queued', 'running', 'awaiting_approval')
      );
    recovered := recovered + 1;
  end loop;
  return recovered;
end
$$;

create or replace function public.recover_all_expired_agent_runs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  stale public.agent_runs;
  recovered integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'worker_scope_denied' using errcode = '42501';
  end if;
  for stale in
    select *
    from public.agent_runs
    where status in ('queued', 'running')
      and (
        (lease_expires_at is not null and lease_expires_at <= now())
        or (
          lease_expires_at is null
          and coalesce(heartbeat_at, started_at, now() - interval '1 day')
            <= now() - interval '2 minutes'
        )
      )
    for update skip locked
  loop
    update public.agent_runs
    set
      status = case when cancel_requested_at is null then 'failed' else 'cancelled' end,
      error = case when cancel_requested_at is null then 'run_interrupted' else null end,
      completed_at = now(),
      lease_token = null,
      lease_expires_at = null
    where id = stale.id;

    if stale.assistant_message_id is not null then
      update public.agent_messages
      set
        status = case when stale.cancel_requested_at is null then 'failed' else 'cancelled' end,
        error = case when stale.cancel_requested_at is null then 'run_interrupted' else null end
      where id = stale.assistant_message_id;
    end if;

    update public.agent_threads
    set
      status = case when stale.cancel_requested_at is null then 'failed' else 'idle' end,
      updated_at = now()
    where id = stale.thread_id
      and not exists (
        select 1
        from public.agent_runs active
        where active.thread_id = stale.thread_id
          and active.id <> stale.id
          and active.status in ('queued', 'running', 'awaiting_approval')
      );
    recovered := recovered + 1;
  end loop;
  return recovered;
end
$$;
