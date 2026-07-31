create or replace function public.fork_agent_branch(
  p_owner_id uuid,
  p_thread_id uuid,
  p_parent_branch_id uuid,
  p_forked_from_message_id uuid
)
returns public.agent_branches
language plpgsql
security definer
set search_path = public
as $$
declare
  branch public.agent_branches;
  parent_branch public.agent_branches;
  fork_message public.agent_messages;
begin
  perform public.assert_service_scope(p_owner_id);

  if not exists (
    select 1
    from public.agent_threads
    where id = p_thread_id and owner_id = p_owner_id and deleted_at is null
  ) then
    raise exception 'thread_not_found';
  end if;

  select *
  into parent_branch
  from public.agent_branches
  where id = p_parent_branch_id
    and owner_id = p_owner_id
    and thread_id = p_thread_id;
  if not found then
    raise exception 'parent_branch_not_found';
  end if;

  select *
  into fork_message
  from public.agent_messages
  where id = p_forked_from_message_id
    and owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = p_parent_branch_id;
  if not found then
    raise exception 'fork_message_scope_invalid';
  end if;

  insert into public.agent_branches (
    owner_id,
    thread_id,
    parent_branch_id,
    forked_from_message_id,
    label
  )
  values (
    p_owner_id,
    p_thread_id,
    p_parent_branch_id,
    p_forked_from_message_id,
    '分支'
  )
  returning * into branch;

  insert into public.agent_messages (
    owner_id,
    thread_id,
    branch_id,
    role,
    content,
    status,
    sources,
    created_at
  )
  select
    owner_id,
    thread_id,
    branch.id,
    role,
    content,
    status,
    sources,
    created_at
  from public.agent_messages
  where owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = p_parent_branch_id
    and (created_at, id) <= (fork_message.created_at, fork_message.id)
  order by created_at, id;

  -- A branch is a semantic conversation fork, not a copy of the parent's
  -- potentially incomplete provider protocol. Rebuild a protocol-safe Session
  -- from the visible messages through the exact fork point. The child receives
  -- its own summary on the next run; a parent summary may include later turns.
  insert into public.agent_session_items (
    owner_id,
    thread_id,
    branch_id,
    sequence,
    item
  )
  select
    p_owner_id,
    p_thread_id,
    branch.id,
    row_number() over (order by created_at, id),
    jsonb_build_object(
      'type', 'message',
      'role', role,
      'content', content
    )
  from public.agent_messages
  where owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = branch.id
  order by created_at, id;

  return branch;
end
$$;

revoke execute on function public.fork_agent_branch(uuid,uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.fork_agent_branch(uuid,uuid,uuid,uuid)
  to service_role;
