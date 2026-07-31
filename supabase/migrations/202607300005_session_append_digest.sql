create or replace function public.append_agent_session_items(
  p_owner_id uuid,
  p_thread_id uuid,
  p_branch_id uuid,
  p_items jsonb,
  p_idempotency_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  next_sequence bigint;
  batch_hash text;
  existing_hash text;
begin
  perform public.assert_service_scope(p_owner_id);
  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':' || p_thread_id::text || ':' || p_branch_id::text, 0)
  );

  if p_idempotency_key is not null then
    batch_hash := encode(extensions.digest(p_items::text, 'sha256'), 'hex');
    select payload_hash
    into existing_hash
    from public.agent_session_append_batches
    where owner_id = p_owner_id
      and thread_id = p_thread_id
      and branch_id = p_branch_id
      and idempotency_key = p_idempotency_key;
    if found then
      if existing_hash <> batch_hash then raise exception 'idempotency_conflict'; end if;
      return;
    end if;
    insert into public.agent_session_append_batches(
      owner_id,
      thread_id,
      branch_id,
      idempotency_key,
      payload_hash,
      item_count
    )
    values (
      p_owner_id,
      p_thread_id,
      p_branch_id,
      p_idempotency_key,
      batch_hash,
      jsonb_array_length(p_items)
    );
  end if;

  select coalesce(max(sequence), 0)
  into next_sequence
  from public.agent_session_items
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

revoke execute on function public.append_agent_session_items(uuid,uuid,uuid,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.append_agent_session_items(uuid,uuid,uuid,jsonb,text)
  to service_role;
