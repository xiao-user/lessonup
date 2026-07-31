alter table public.agent_messages
  drop constraint if exists agent_messages_status_check;

alter table public.agent_messages
  add constraint agent_messages_status_check
  check (status in ('completed', 'streaming', 'cancelled', 'failed'));

alter table public.agent_runs
  add column if not exists attachment_source_ids uuid[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_runs_owner_id_id_unique'
      and conrelid = 'public.agent_runs'::regclass
  ) then
    alter table public.agent_runs
      add constraint agent_runs_owner_id_id_unique unique(owner_id, id);
  end if;
end
$$;

create table if not exists public.agent_run_evidence (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  run_id uuid not null,
  kind text not null check (
    kind in (
      'knowledge_search',
      'knowledge_passage',
      'attachment_read',
      'source_metadata',
      'web_search',
      'web_open'
    )
  ),
  source_id text not null,
  source jsonb not null,
  created_at timestamptz not null default now(),
  unique (owner_id, run_id, kind, source_id),
  foreign key (owner_id, run_id)
    references public.agent_runs(owner_id, id)
    on delete cascade
);

alter table public.agent_run_evidence enable row level security;
revoke all on public.agent_run_evidence from public, anon, authenticated;
grant select, insert, update on public.agent_run_evidence to service_role;

create or replace function public.settle_agent_approval_continuation(
  p_owner_id uuid,
  p_approval_id uuid,
  p_lease_token text,
  p_outcome text,
  p_assistant_message_id uuid,
  p_content text,
  p_sources jsonb,
  p_session_cursor bigint,
  p_token_usage jsonb,
  p_encrypted_run_state text,
  p_error text
)
returns public.agent_approvals
language plpgsql
security definer
set search_path = public
as $$
declare
  approval public.agent_approvals;
  message_status text;
  run_status text;
begin
  perform public.assert_service_scope(p_owner_id);
  if p_outcome not in ('ready', 'paused', 'completed', 'cancelled') then
    raise exception 'invalid_continuation_outcome';
  end if;

  select *
  into approval
  from public.agent_approvals
  where owner_id = p_owner_id and id = p_approval_id
  for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.continuation_status = 'completed' then return approval; end if;
  if approval.continuation_status <> 'running'
    or approval.continuation_lease_token is distinct from p_lease_token
  then
    raise exception 'approval_lease_lost';
  end if;
  if p_assistant_message_id is not null
    and approval.continuation_message_id is distinct from p_assistant_message_id
  then
    raise exception 'approval_continuation_message_invalid';
  end if;

  if p_outcome = 'paused' then
    update public.agent_approvals
    set encrypted_run_state = coalesce(p_encrypted_run_state, encrypted_run_state),
        continuation_status = 'completed',
        continuation_lease_token = null,
        continuation_lease_expires_at = null,
        continuation_error = p_error
    where id = approval.id
    returning * into approval;
    return approval;
  elsif p_outcome = 'ready' then
    message_status := 'failed';
    run_status := 'failed';
  elsif p_outcome = 'cancelled' then
    message_status := 'cancelled';
    run_status := 'cancelled';
  else
    message_status := 'completed';
    run_status := 'completed';
  end if;

  update public.agent_approvals
  set
    encrypted_run_state = coalesce(p_encrypted_run_state, encrypted_run_state),
    continuation_status = case when p_outcome = 'ready' then 'ready' else 'completed' end,
    continuation_lease_token = null,
    continuation_lease_expires_at = null,
    continuation_error = p_error
  where owner_id = p_owner_id and id = p_approval_id
  returning * into approval;

  if p_assistant_message_id is not null then
    update public.agent_messages
    set
      content = coalesce(p_content, content),
      sources = coalesce(p_sources, sources),
      session_cursor = coalesce(p_session_cursor, session_cursor),
      status = message_status
    where owner_id = p_owner_id
      and id = p_assistant_message_id
      and thread_id = approval.thread_id
      and branch_id = approval.branch_id;
    if not found then raise exception 'approval_continuation_message_missing'; end if;
  end if;

  update public.agent_runs
  set
    status = run_status,
    token_usage = coalesce(p_token_usage, token_usage),
    error = case when p_outcome = 'ready' then p_error else null end,
    completed_at = now()
  where owner_id = p_owner_id and id = approval.run_id;
  if not found then raise exception 'run_not_found'; end if;

  update public.agent_threads
  set status = case when p_outcome = 'ready' then 'failed' else 'idle' end
  where owner_id = p_owner_id and id = approval.thread_id;
  if not found then raise exception 'thread_not_found'; end if;

  return approval;
end
$$;

revoke execute on function public.settle_agent_approval_continuation(
  uuid, uuid, text, text, uuid, text, jsonb, bigint, jsonb, text, text
) from public, anon, authenticated;

grant execute on function public.settle_agent_approval_continuation(
  uuid, uuid, text, text, uuid, text, jsonb, bigint, jsonb, text, text
) to service_role;
