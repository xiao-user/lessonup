-- Commit the SDK Session snapshot and approval continuation settlement in one
-- transaction. A process crash must never leave the Session ahead of the
-- encrypted RunState or the durable run/message lifecycle.
drop function if exists public.settle_agent_approval_continuation(
  uuid, uuid, text, text, uuid, text, jsonb, bigint, jsonb, text, text
);

create function public.settle_agent_approval_continuation(
  p_owner_id uuid,
  p_approval_id uuid,
  p_lease_token text,
  p_outcome text,
  p_assistant_message_id uuid,
  p_content text,
  p_sources jsonb,
  p_session_items jsonb,
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
  effective_session_cursor bigint;
begin
  perform public.assert_service_scope(p_owner_id);
  if p_outcome not in ('ready', 'paused', 'completed', 'cancelled') then
    raise exception 'invalid_continuation_outcome';
  end if;

  select * into approval
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

  effective_session_cursor := p_session_cursor;
  if p_session_items is not null then
    if jsonb_typeof(p_session_items) <> 'array' then
      raise exception 'session_items_invalid';
    end if;
    perform public.replace_agent_session_items(
      p_owner_id,
      approval.thread_id,
      approval.branch_id,
      p_session_items
    );
    effective_session_cursor := jsonb_array_length(p_session_items);
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

    if p_assistant_message_id is not null then
      update public.agent_messages
      set content = coalesce(p_content, content),
          sources = coalesce(p_sources, sources),
          session_cursor = coalesce(effective_session_cursor, session_cursor),
          status = 'completed',
          error = null
      where owner_id = p_owner_id
        and id = p_assistant_message_id
        and thread_id = approval.thread_id
        and branch_id = approval.branch_id;
      if not found then raise exception 'approval_continuation_message_missing'; end if;
    end if;
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
  set encrypted_run_state = coalesce(p_encrypted_run_state, encrypted_run_state),
      continuation_status = case when p_outcome = 'ready' then 'ready' else 'completed' end,
      continuation_lease_token = null,
      continuation_lease_expires_at = null,
      continuation_error = p_error
  where owner_id = p_owner_id and id = p_approval_id
  returning * into approval;

  if p_assistant_message_id is not null then
    update public.agent_messages
    set content = coalesce(p_content, content),
        sources = coalesce(p_sources, sources),
        session_cursor = coalesce(effective_session_cursor, session_cursor),
        status = message_status,
        error = case when p_outcome = 'ready' then p_error else null end
    where owner_id = p_owner_id
      and id = p_assistant_message_id
      and thread_id = approval.thread_id
      and branch_id = approval.branch_id;
    if not found then raise exception 'approval_continuation_message_missing'; end if;
  end if;

  update public.agent_runs
  set status = run_status,
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
  uuid, uuid, text, text, uuid, text, jsonb, jsonb, bigint, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.settle_agent_approval_continuation(
  uuid, uuid, text, text, uuid, text, jsonb, jsonb, bigint, jsonb, text, text
) to service_role;
