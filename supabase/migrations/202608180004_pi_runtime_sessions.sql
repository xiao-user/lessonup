create table if not exists public.agent_runtime_sessions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  branch_id uuid not null,
  runtime text not null check (runtime in ('pi')),
  revision bigint not null default 1 check (revision > 0),
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  updated_at timestamptz not null default now(),
  primary key (owner_id, thread_id, branch_id, runtime),
  constraint agent_runtime_sessions_owner_thread_branch_fkey
    foreign key (owner_id, thread_id, branch_id)
    references public.agent_branches(owner_id, thread_id, id) on delete cascade
);

create index if not exists agent_runtime_sessions_thread_branch
  on public.agent_runtime_sessions(owner_id, thread_id, branch_id);

alter table public.agent_runtime_sessions enable row level security;
revoke all on public.agent_runtime_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.agent_runtime_sessions to service_role;

create or replace function public.save_agent_runtime_session(
  p_owner_id uuid,
  p_thread_id uuid,
  p_branch_id uuid,
  p_runtime text,
  p_expected_revision bigint,
  p_messages jsonb
)
returns public.agent_runtime_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  current_session public.agent_runtime_sessions;
begin
  perform public.assert_service_scope(p_owner_id);
  if p_runtime <> 'pi' then raise exception 'agent_runtime_unsupported'; end if;
  if p_expected_revision < 0 then raise exception 'agent_runtime_session_revision_invalid'; end if;
  if jsonb_typeof(p_messages) <> 'array' then raise exception 'agent_runtime_messages_invalid'; end if;
  if not exists (
    select 1
    from public.agent_branches
    where owner_id = p_owner_id
      and thread_id = p_thread_id
      and id = p_branch_id
  ) then
    raise exception 'agent_runtime_session_scope_invalid';
  end if;

  select * into current_session
  from public.agent_runtime_sessions
  where owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = p_branch_id
    and runtime = p_runtime
  for update;

  if found then
    if current_session.revision <> p_expected_revision then
      raise exception 'agent_runtime_session_conflict';
    end if;
    update public.agent_runtime_sessions
    set revision = revision + 1,
        messages = p_messages,
        updated_at = now()
    where owner_id = p_owner_id
      and thread_id = p_thread_id
      and branch_id = p_branch_id
      and runtime = p_runtime
    returning * into current_session;
    return current_session;
  end if;

  if p_expected_revision <> 0 then raise exception 'agent_runtime_session_conflict'; end if;
  begin
    insert into public.agent_runtime_sessions(
      owner_id, thread_id, branch_id, runtime, revision, messages
    ) values (
      p_owner_id, p_thread_id, p_branch_id, p_runtime, 1, p_messages
    ) returning * into current_session;
  exception when unique_violation then
    raise exception 'agent_runtime_session_conflict';
  end;
  return current_session;
end
$$;

revoke all on function public.save_agent_runtime_session(uuid,uuid,uuid,text,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.save_agent_runtime_session(uuid,uuid,uuid,text,bigint,jsonb)
  to service_role;

-- Branches inherit the exact protocol-safe transcript through the selected
-- message cursor. OpenAI SDK session rows and Pi snapshots remain independent.
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
  fork_message public.agent_messages;
  parent_session_count bigint;
  parent_pi_session_count bigint;
begin
  perform public.assert_service_scope(p_owner_id);

  if not exists (
    select 1 from public.agent_threads
    where id = p_thread_id and owner_id = p_owner_id and deleted_at is null
  ) then raise exception 'thread_not_found'; end if;

  perform 1 from public.agent_branches
  where id = p_parent_branch_id
    and owner_id = p_owner_id
    and thread_id = p_thread_id;
  if not found then raise exception 'parent_branch_not_found'; end if;

  select * into fork_message
  from public.agent_messages
  where id = p_forked_from_message_id
    and owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = p_parent_branch_id;
  if not found then raise exception 'fork_message_scope_invalid'; end if;

  if fork_message.session_cursor is not null then
    select count(*) into parent_session_count
    from public.agent_session_items
    where owner_id = p_owner_id
      and thread_id = p_thread_id
      and branch_id = p_parent_branch_id;
    select coalesce(jsonb_array_length(messages), 0) into parent_pi_session_count
    from public.agent_runtime_sessions
    where owner_id = p_owner_id
      and thread_id = p_thread_id
      and branch_id = p_parent_branch_id
      and runtime = 'pi';
    parent_pi_session_count := coalesce(parent_pi_session_count, 0);
    if parent_session_count < fork_message.session_cursor
      and parent_pi_session_count < fork_message.session_cursor
    then raise exception 'fork_session_not_committed'; end if;
  end if;

  insert into public.agent_branches(
    owner_id, thread_id, parent_branch_id, forked_from_message_id, label
  ) values (
    p_owner_id, p_thread_id, p_parent_branch_id, p_forked_from_message_id, '分支'
  ) returning * into branch;

  insert into public.agent_messages(
    owner_id, thread_id, branch_id, role, content, status, sources,
    session_cursor, created_at
  )
  select owner_id, thread_id, branch.id, role, content, status, sources,
    session_cursor, created_at
  from public.agent_messages
  where owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = p_parent_branch_id
    and sequence <= fork_message.sequence
  order by sequence;

  if fork_message.session_cursor is not null then
    insert into public.agent_session_items(
      owner_id, thread_id, branch_id, sequence, item, created_at
    )
    select p_owner_id, p_thread_id, branch.id, sequence, item, created_at
    from public.agent_session_items
    where owner_id = p_owner_id
      and thread_id = p_thread_id
      and branch_id = p_parent_branch_id
      and sequence <= fork_message.session_cursor
    order by sequence;

    insert into public.agent_thread_memories(
      owner_id, thread_id, branch_id, summary, summary_cursor, updated_at
    )
    select p_owner_id, p_thread_id, branch.id, summary, summary_cursor, updated_at
    from public.agent_thread_memories
    where owner_id = p_owner_id
      and thread_id = p_thread_id
      and branch_id = p_parent_branch_id
      and summary_cursor <= fork_message.session_cursor;
  else
    insert into public.agent_session_items(owner_id, thread_id, branch_id, sequence, item)
    select p_owner_id, p_thread_id, branch.id,
      row_number() over (order by sequence),
      jsonb_build_object('type', 'message', 'role', role, 'content', content)
    from public.agent_messages
    where owner_id = p_owner_id
      and thread_id = p_thread_id
      and branch_id = branch.id
    order by sequence;
  end if;

  insert into public.agent_runtime_sessions(
    owner_id, thread_id, branch_id, runtime, revision, messages, updated_at
  )
  select
    p_owner_id,
    p_thread_id,
    branch.id,
    runtime,
    1,
    case
      when fork_message.session_cursor is null then messages
      else (
        select coalesce(jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb)
        from jsonb_array_elements(messages) with ordinality as entry(value, ordinality)
        where entry.ordinality <= fork_message.session_cursor
      )
    end,
    now()
  from public.agent_runtime_sessions
  where owner_id = p_owner_id
    and thread_id = p_thread_id
    and branch_id = p_parent_branch_id;

  return branch;
end
$$;

revoke execute on function public.fork_agent_branch(uuid,uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.fork_agent_branch(uuid,uuid,uuid,uuid)
  to service_role;
