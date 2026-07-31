alter table public.notebooks
  add column if not exists tone text not null default 'teal'
  check (tone in ('teal', 'sage', 'amber', 'coral'));

create index if not exists notebooks_owner_updated
  on public.notebooks(owner_id, updated_at desc);
create index if not exists lesson_files_owner_updated
  on public.lesson_files(owner_id, updated_at desc);
create index if not exists agent_branches_owner_thread_created
  on public.agent_branches(owner_id, thread_id, created_at, id);
create index if not exists agent_runs_owner_thread_branch_started
  on public.agent_runs(owner_id, thread_id, branch_id, started_at desc);
create index if not exists agent_approvals_pending_lookup
  on public.agent_approvals(owner_id, thread_id, branch_id, expires_at, created_at)
  where state = 'pending';
create index if not exists agent_events_owner_run_id
  on public.agent_events(owner_id, run_id, id);
create index if not exists knowledge_sources_owner_scope_updated
  on public.knowledge_sources(owner_id, scope, updated_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_threads_owner_id_id_unique'
      and conrelid = 'public.agent_threads'::regclass
  ) then
    alter table public.agent_threads
      add constraint agent_threads_owner_id_id_unique unique(owner_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_branches_owner_thread_id_unique'
      and conrelid = 'public.agent_branches'::regclass
  ) then
    alter table public.agent_branches
      add constraint agent_branches_owner_thread_id_unique unique(owner_id, thread_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_runs_owner_thread_branch_id_unique'
      and conrelid = 'public.agent_runs'::regclass
  ) then
    alter table public.agent_runs
      add constraint agent_runs_owner_thread_branch_id_unique unique(owner_id, thread_id, branch_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_branches_owner_thread_fkey'
      and conrelid = 'public.agent_branches'::regclass
  ) then
    alter table public.agent_branches
      add constraint agent_branches_owner_thread_fkey
      foreign key(owner_id, thread_id)
      references public.agent_threads(owner_id, id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_messages_owner_thread_branch_fkey'
      and conrelid = 'public.agent_messages'::regclass
  ) then
    alter table public.agent_messages
      add constraint agent_messages_owner_thread_branch_fkey
      foreign key(owner_id, thread_id, branch_id)
      references public.agent_branches(owner_id, thread_id, id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_session_items_owner_thread_branch_fkey'
      and conrelid = 'public.agent_session_items'::regclass
  ) then
    alter table public.agent_session_items
      add constraint agent_session_items_owner_thread_branch_fkey
      foreign key(owner_id, thread_id, branch_id)
      references public.agent_branches(owner_id, thread_id, id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_thread_memories_owner_thread_branch_fkey'
      and conrelid = 'public.agent_thread_memories'::regclass
  ) then
    alter table public.agent_thread_memories
      add constraint agent_thread_memories_owner_thread_branch_fkey
      foreign key(owner_id, thread_id, branch_id)
      references public.agent_branches(owner_id, thread_id, id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_runs_owner_thread_branch_fkey'
      and conrelid = 'public.agent_runs'::regclass
  ) then
    alter table public.agent_runs
      add constraint agent_runs_owner_thread_branch_fkey
      foreign key(owner_id, thread_id, branch_id)
      references public.agent_branches(owner_id, thread_id, id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_approvals_owner_run_scope_fkey'
      and conrelid = 'public.agent_approvals'::regclass
  ) then
    alter table public.agent_approvals
      add constraint agent_approvals_owner_run_scope_fkey
      foreign key(owner_id, thread_id, branch_id, run_id)
      references public.agent_runs(owner_id, thread_id, branch_id, id) on delete cascade;
  end if;
end
$$;

alter table public.knowledge_sources
  drop constraint if exists knowledge_sources_scope_shape_check;
alter table public.knowledge_sources
  add constraint knowledge_sources_scope_shape_check check (
    (scope = 'public' and owner_id is null and notebook_id is null and lesson_file_id is null)
    or (scope = 'user' and owner_id is not null and notebook_id is null and lesson_file_id is null)
    or (scope = 'notebook' and owner_id is not null and notebook_id is not null and lesson_file_id is null)
    or (scope = 'file' and owner_id is not null and notebook_id is not null and lesson_file_id is not null)
  );

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'knowledge_sources_owner_notebook_fkey'
      and conrelid = 'public.knowledge_sources'::regclass
  ) then
    alter table public.knowledge_sources
      add constraint knowledge_sources_owner_notebook_fkey
      foreign key(owner_id, notebook_id)
      references public.notebooks(owner_id, id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'knowledge_sources_owner_file_fkey'
      and conrelid = 'public.knowledge_sources'::regclass
  ) then
    alter table public.knowledge_sources
      add constraint knowledge_sources_owner_file_fkey
      foreign key(owner_id, lesson_file_id)
      references public.lesson_files(owner_id, id) on delete cascade;
  end if;
end
$$;

delete from public.agent_events where type = 'message.delta';
alter table public.agent_events
  drop constraint if exists agent_events_no_stream_delta;
alter table public.agent_events
  add constraint agent_events_no_stream_delta check (type <> 'message.delta');

create or replace function public.create_lesson_file(
  p_owner_id uuid,
  p_file_id text,
  p_notebook_id text,
  p_title text,
  p_type text,
  p_image text,
  p_document jsonb,
  p_page_count integer,
  p_idempotency_key text
)
returns public.lesson_files
language plpgsql
security definer
set search_path = public
as $$
declare
  created_file public.lesson_files;
  existing_version public.lesson_file_versions;
begin
  perform public.assert_service_scope(p_owner_id);
  select * into existing_version
  from public.lesson_file_versions
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    select * into created_file
    from public.lesson_files
    where owner_id = p_owner_id and id = existing_version.lesson_file_id;
    return created_file;
  end if;
  if not exists (
    select 1 from public.notebooks
    where owner_id = p_owner_id and id = p_notebook_id
  ) then
    raise exception 'notebook_not_found';
  end if;
  insert into public.lesson_files(
    owner_id, id, notebook_id, title, type, image, document, page_count
  )
  values (
    p_owner_id, p_file_id, p_notebook_id, p_title, p_type, p_image, p_document, p_page_count
  )
  returning * into created_file;
  insert into public.lesson_file_versions(
    owner_id, lesson_file_id, document_version, document, page_count, actor, idempotency_key
  )
  values (
    p_owner_id, p_file_id, 0, p_document, p_page_count, 'import', p_idempotency_key
  );
  update public.notebooks set updated_at = now()
  where owner_id = p_owner_id and id = p_notebook_id;
  return created_file;
end
$$;

revoke execute on function public.create_lesson_file(
  uuid,text,text,text,text,text,jsonb,integer,text
) from public, anon, authenticated;
grant execute on function public.create_lesson_file(
  uuid,text,text,text,text,text,jsonb,integer,text
) to service_role;

create or replace function public.import_lessonup_notebooks(
  p_owner_id uuid,
  p_notebooks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  notebook jsonb;
  file jsonb;
  imported integer := 0;
begin
  perform public.assert_service_scope(p_owner_id);
  for notebook in select * from jsonb_array_elements(p_notebooks) loop
    insert into public.notebooks(owner_id,id,title,class_name,year,subject,tone)
    values (
      p_owner_id,
      notebook->>'id',
      notebook->>'title',
      notebook->>'className',
      notebook->>'year',
      notebook->>'subject',
      coalesce(notebook->>'tone', 'teal')
    )
    on conflict (owner_id,id) do update set
      title=excluded.title,
      class_name=excluded.class_name,
      year=excluded.year,
      subject=excluded.subject,
      tone=excluded.tone,
      updated_at=now();
    for file in select * from jsonb_array_elements(coalesce(notebook->'files','[]'::jsonb)) loop
      insert into public.lesson_files(owner_id,id,notebook_id,title,type,image,document,page_count)
      values (
        p_owner_id,
        file->>'id',
        notebook->>'id',
        file->>'title',
        coalesce(file->>'type','教案'),
        file->>'image',
        file->'lessonPlan',
        coalesce((file->>'pages')::integer,1)
      )
      on conflict (owner_id,id) do nothing;
      if found then
        imported := imported + 1;
        insert into public.lesson_file_versions(
          owner_id,lesson_file_id,document_version,document,page_count,actor,idempotency_key
        )
        values (
          p_owner_id,
          file->>'id',
          0,
          file->'lessonPlan',
          coalesce((file->>'pages')::integer,1),
          'import',
          'import:' || (file->>'id')
        );
      end if;
    end loop;
  end loop;
  return jsonb_build_object('imported', imported);
end
$$;

revoke execute on function public.import_lessonup_notebooks(uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.import_lessonup_notebooks(uuid,jsonb)
  to service_role;

drop policy if exists lessonup_knowledge_owner on storage.objects;

create or replace function public.perform_lessonup_maintenance(
  p_thread_retention_days integer default 30,
  p_event_retention_days integer default 30,
  p_manual_version_retention_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  expired_approvals integer := 0;
  expired_runs integer := 0;
  purged_threads integer := 0;
  purged_events integer := 0;
  purged_versions integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'worker_scope_denied' using errcode = '42501';
  end if;

  with expired as (
    update public.agent_approvals
    set state = 'expired'
    where state = 'pending' and expires_at <= now()
    returning run_id
  )
  select count(*) into expired_approvals from expired;

  with expired as (
    update public.agent_runs r
    set status = 'failed', error = 'approval_expired', completed_at = now()
    where status = 'awaiting_approval'
      and exists (
        select 1 from public.agent_approvals a
        where a.run_id = r.id and a.state = 'expired'
      )
    returning id
  )
  select count(*) into expired_runs from expired;

  with purged as (
    delete from public.agent_threads
    where deleted_at is not null
      and deleted_at < now() - make_interval(days => greatest(1, p_thread_retention_days))
    returning id
  )
  select count(*) into purged_threads from purged;

  with purged as (
    delete from public.agent_events
    where created_at < now() - make_interval(days => greatest(1, p_event_retention_days))
    returning id
  )
  select count(*) into purged_events from purged;

  with latest as (
    select owner_id, lesson_file_id, max(document_version) as document_version
    from public.lesson_file_versions
    group by owner_id, lesson_file_id
  ),
  purged as (
    delete from public.lesson_file_versions v
    using latest
    where v.owner_id = latest.owner_id
      and v.lesson_file_id = latest.lesson_file_id
      and v.actor = 'manual'
      and v.document_version <> latest.document_version
      and v.created_at < now() - make_interval(days => greatest(1, p_manual_version_retention_days))
    returning v.id
  )
  select count(*) into purged_versions from purged;

  return jsonb_build_object(
    'expiredApprovals', expired_approvals,
    'expiredRuns', expired_runs,
    'purgedThreads', purged_threads,
    'purgedEvents', purged_events,
    'purgedManualVersions', purged_versions
  );
end
$$;

revoke execute on function public.perform_lessonup_maintenance(integer,integer,integer)
  from public, anon, authenticated;
grant execute on function public.perform_lessonup_maintenance(integer,integer,integer)
  to service_role;
