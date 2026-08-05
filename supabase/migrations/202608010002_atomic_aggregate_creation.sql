-- Create lesson-file and conversation aggregates in one transaction and make
-- response-loss retries replay the original aggregate instead of duplicating it.

drop function if exists public.create_lesson_file(
  uuid,text,text,text,text,text,jsonb,integer,text
);

create function public.create_lesson_file(
  p_owner_id uuid,
  p_file_id text,
  p_notebook_id text,
  p_title text,
  p_type text,
  p_image text,
  p_document jsonb,
  p_page_count integer,
  p_context_profile jsonb,
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
  request_hash text;
begin
  perform public.assert_service_scope(p_owner_id);
  request_hash := encode(extensions.digest(jsonb_build_object(
    'notebookId', p_notebook_id,
    'title', p_title,
    'type', p_type,
    'image', p_image,
    'document', p_document,
    'pageCount', p_page_count,
    'contextProfile', coalesce(p_context_profile, '{}'::jsonb)
  )::text, 'sha256'), 'hex');

  select * into existing_version
  from public.lesson_file_versions
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_version.request_hash is not null
      and existing_version.request_hash <> request_hash
    then
      raise exception 'idempotency_conflict';
    end if;
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
    owner_id,id,notebook_id,title,type,image,document,page_count,context_profile
  ) values (
    p_owner_id,p_file_id,p_notebook_id,p_title,p_type,p_image,p_document,p_page_count,
    coalesce(p_context_profile, '{}'::jsonb)
  ) returning * into created_file;

  insert into public.lesson_file_versions(
    owner_id,lesson_file_id,document_version,document,page_count,actor,idempotency_key,request_hash
  ) values (
    p_owner_id,p_file_id,0,p_document,p_page_count,'import',p_idempotency_key,request_hash
  );

  update public.notebooks set updated_at = now()
  where owner_id = p_owner_id and id = p_notebook_id;
  return created_file;
end
$$;

revoke execute on function public.create_lesson_file(
  uuid,text,text,text,text,text,jsonb,integer,jsonb,text
) from public, anon, authenticated;
grant execute on function public.create_lesson_file(
  uuid,text,text,text,text,text,jsonb,integer,jsonb,text
) to service_role;

alter table public.agent_threads
  add column if not exists create_idempotency_key text,
  add column if not exists create_request_hash text;

create unique index if not exists agent_threads_create_idempotency
  on public.agent_threads(owner_id, create_idempotency_key)
  where create_idempotency_key is not null;

create or replace function public.create_agent_thread(
  p_owner_id uuid,
  p_thread_id uuid,
  p_branch_id uuid,
  p_notebook_id text,
  p_lesson_file_id text,
  p_title text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created_thread public.agent_threads;
  created_branch public.agent_branches;
  request_hash text;
begin
  perform public.assert_service_scope(p_owner_id);
  request_hash := encode(extensions.digest(jsonb_build_object(
    'notebookId', p_notebook_id,
    'lessonFileId', p_lesson_file_id,
    'title', p_title
  )::text, 'sha256'), 'hex');

  select * into created_thread
  from public.agent_threads
  where owner_id = p_owner_id and create_idempotency_key = p_idempotency_key;
  if found then
    if created_thread.create_request_hash <> request_hash then
      raise exception 'idempotency_conflict';
    end if;
    select * into created_branch
    from public.agent_branches
    where owner_id = p_owner_id and thread_id = created_thread.id
    order by created_at, id
    limit 1;
    if not found then raise exception 'thread_branch_missing'; end if;
    return jsonb_build_object('thread', to_jsonb(created_thread), 'branch', to_jsonb(created_branch));
  end if;

  if not exists (
    select 1 from public.lesson_files
    where owner_id = p_owner_id
      and id = p_lesson_file_id
      and notebook_id = p_notebook_id
  ) then
    raise exception 'lesson_file_not_found';
  end if;

  insert into public.agent_threads(
    id,owner_id,notebook_id,lesson_file_id,title,create_idempotency_key,create_request_hash
  ) values (
    p_thread_id,p_owner_id,p_notebook_id,p_lesson_file_id,p_title,p_idempotency_key,request_hash
  ) returning * into created_thread;

  insert into public.agent_branches(id,owner_id,thread_id,label)
  values (p_branch_id,p_owner_id,p_thread_id,'主分支')
  returning * into created_branch;

  return jsonb_build_object('thread', to_jsonb(created_thread), 'branch', to_jsonb(created_branch));
end
$$;

revoke execute on function public.create_agent_thread(uuid,uuid,uuid,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.create_agent_thread(uuid,uuid,uuid,text,text,text,text)
  to service_role;
