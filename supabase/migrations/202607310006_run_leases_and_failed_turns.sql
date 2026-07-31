alter table public.agent_runs
  add column if not exists lease_token text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists assistant_message_id uuid;

alter table public.agent_messages
  add column if not exists error text;

create index if not exists agent_runs_expired_lease
  on public.agent_runs(lease_expires_at)
  where status in ('queued', 'running');

-- Runs created before leases existed cannot have a live owner after this
-- migration. Make them immediately recoverable instead of leaving a permanent
-- active-run tombstone.
update public.agent_runs
set
  lease_token = coalesce(lease_token, 'legacy-unowned'),
  lease_expires_at = coalesce(lease_expires_at, now() - interval '1 second')
where status in ('queued', 'running');

create or replace function public.heartbeat_agent_run(
  p_owner_id uuid,
  p_run_id uuid,
  p_lease_token text,
  p_lease_expires_at timestamptz
)
returns public.agent_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  run public.agent_runs;
begin
  perform public.assert_service_scope(p_owner_id);
  if p_lease_expires_at <= now() then raise exception 'invalid_run_lease'; end if;

  update public.agent_runs
  set
    status = 'running',
    heartbeat_at = now(),
    lease_expires_at = p_lease_expires_at
  where owner_id = p_owner_id
    and id = p_run_id
    and status in ('queued', 'running')
    and lease_token = p_lease_token
    and lease_expires_at > now()
  returning * into run;
  if not found then raise exception 'run_lease_lost'; end if;
  return run;
end
$$;

create or replace function public.settle_agent_run(
  p_owner_id uuid,
  p_run_id uuid,
  p_lease_token text,
  p_status text,
  p_token_usage jsonb,
  p_error text,
  p_message_status text,
  p_message_content text,
  p_message_sources jsonb,
  p_session_cursor bigint
)
returns public.agent_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  run public.agent_runs;
  thread_status text;
begin
  perform public.assert_service_scope(p_owner_id);
  if p_status not in ('awaiting_approval', 'completed', 'cancelled', 'failed') then
    raise exception 'invalid_run_settlement';
  end if;
  if p_message_status is not null
    and p_message_status not in ('completed', 'cancelled', 'failed')
  then
    raise exception 'invalid_message_settlement';
  end if;

  select * into run
  from public.agent_runs
  where owner_id = p_owner_id and id = p_run_id
  for update;
  if not found then raise exception 'run_not_found'; end if;
  if run.status = p_status and run.lease_token is null then return run; end if;
  if run.status not in ('queued', 'running')
    or run.lease_token is distinct from p_lease_token
    or run.lease_expires_at is null
    or run.lease_expires_at <= now()
  then
    raise exception 'run_lease_lost';
  end if;
  if run.cancel_requested_at is not null and p_status <> 'cancelled' then
    raise exception 'run_cancel_requested';
  end if;

  update public.agent_runs
  set
    status = p_status,
    token_usage = coalesce(p_token_usage, token_usage),
    error = p_error,
    completed_at = case when p_status = 'awaiting_approval' then null else now() end,
    lease_token = null,
    lease_expires_at = null,
    heartbeat_at = now()
  where owner_id = p_owner_id and id = p_run_id
  returning * into run;

  if run.assistant_message_id is not null and p_message_status is not null then
    update public.agent_messages
    set
      status = p_message_status,
      content = coalesce(p_message_content, content),
      sources = coalesce(p_message_sources, sources),
      session_cursor = coalesce(p_session_cursor, session_cursor),
      error = p_error
    where owner_id = p_owner_id
      and id = run.assistant_message_id
      and thread_id = run.thread_id
      and branch_id = run.branch_id;
  end if;

  thread_status := case
    when p_status = 'awaiting_approval' then 'awaiting_approval'
    when p_status = 'failed' then 'failed'
    else 'idle'
  end;
  update public.agent_threads
  set status = thread_status, updated_at = now()
  where owner_id = p_owner_id and id = run.thread_id;

  return run;
end
$$;

create or replace function public.request_agent_run_cancellation(
  p_owner_id uuid,
  p_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  run public.agent_runs;
begin
  perform public.assert_service_scope(p_owner_id);
  select * into run
  from public.agent_runs
  where owner_id = p_owner_id and id = p_run_id
  for update;
  if not found then raise exception 'run_not_found'; end if;
  if run.status = 'cancelled' then return true; end if;
  if run.status not in ('queued', 'running') then return false; end if;

  update public.agent_runs
  set cancel_requested_at = coalesce(cancel_requested_at, now())
  where owner_id = p_owner_id and id = p_run_id
  returning * into run;

  if run.lease_expires_at is null or run.lease_expires_at <= now() then
    update public.agent_runs
    set
      status = 'cancelled',
      error = null,
      completed_at = now(),
      lease_token = null,
      lease_expires_at = null
    where owner_id = p_owner_id and id = p_run_id;
    if run.assistant_message_id is not null then
      update public.agent_messages
      set status = 'cancelled', error = null
      where owner_id = p_owner_id and id = run.assistant_message_id;
    end if;
    update public.agent_threads
    set status = 'idle', updated_at = now()
    where owner_id = p_owner_id and id = run.thread_id;
  end if;
  return true;
end
$$;

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
      and lease_expires_at is not null
      and lease_expires_at <= now()
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
      and lease_expires_at is not null
      and lease_expires_at <= now()
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
      where owner_id = stale.owner_id and id = stale.assistant_message_id;
    end if;
    update public.agent_threads
    set
      status = case when stale.cancel_requested_at is null then 'failed' else 'idle' end,
      updated_at = now()
    where owner_id = stale.owner_id
      and id = stale.thread_id
      and not exists (
        select 1 from public.agent_runs active
        where active.owner_id = stale.owner_id
          and active.thread_id = stale.thread_id
          and active.id <> stale.id
          and active.status in ('queued', 'running', 'awaiting_approval')
      );
    recovered := recovered + 1;
  end loop;
  return recovered;
end
$$;

revoke execute on function public.heartbeat_agent_run(uuid,uuid,text,timestamptz)
from public, anon, authenticated;
revoke execute on function public.settle_agent_run(
  uuid,uuid,text,text,jsonb,text,text,text,jsonb,bigint
) from public, anon, authenticated;
revoke execute on function public.request_agent_run_cancellation(uuid,uuid)
from public, anon, authenticated;
revoke execute on function public.recover_expired_agent_runs(uuid,uuid)
from public, anon, authenticated;
revoke execute on function public.recover_all_expired_agent_runs()
from public, anon, authenticated;

grant execute on function public.heartbeat_agent_run(uuid,uuid,text,timestamptz)
to service_role;
grant execute on function public.settle_agent_run(
  uuid,uuid,text,text,jsonb,text,text,text,jsonb,bigint
) to service_role;
grant execute on function public.request_agent_run_cancellation(uuid,uuid)
to service_role;
grant execute on function public.recover_expired_agent_runs(uuid,uuid)
to service_role;
grant execute on function public.recover_all_expired_agent_runs()
to service_role;
