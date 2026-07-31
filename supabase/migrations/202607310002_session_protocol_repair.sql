create or replace function public.replace_agent_session_items(
  p_owner_id uuid,
  p_thread_id uuid,
  p_branch_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  next_sequence bigint := 0;
begin
  perform public.assert_service_scope(p_owner_id);
  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':' || p_thread_id::text || ':' || p_branch_id::text, 0)
  );

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'session_items_invalid';
  end if;

  if not exists (
    select 1
    from public.agent_branches branch
    join public.agent_threads thread
      on thread.id = branch.thread_id
     and thread.owner_id = branch.owner_id
    where branch.owner_id = p_owner_id
      and branch.id = p_branch_id
      and branch.thread_id = p_thread_id
  ) then
    raise exception 'thread_scope_invalid';
  end if;

  delete from public.agent_session_items
  where owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = p_branch_id;

  delete from public.agent_session_append_batches
  where owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = p_branch_id;

  delete from public.agent_thread_memories
  where owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = p_branch_id;

  for item in select * from jsonb_array_elements(p_items)
  loop
    next_sequence := next_sequence + 1;
    insert into public.agent_session_items(owner_id, thread_id, branch_id, sequence, item)
    values (p_owner_id, p_thread_id, p_branch_id, next_sequence, item);
  end loop;
end
$$;

revoke execute on function public.replace_agent_session_items(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_agent_session_items(uuid,uuid,uuid,jsonb)
  to service_role;
