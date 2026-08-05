-- Generalize Agent ownership from a lesson-file-only foreign key to a checked
-- union of lesson_file | semester_framework. Existing lesson threads and APIs
-- remain valid.

alter table public.lesson_files
  add constraint lesson_files_owner_notebook_id_unique
  unique (owner_id, notebook_id, id);
alter table public.semester_frameworks
  add constraint semester_frameworks_owner_notebook_id_unique
  unique (owner_id, notebook_id, id);

alter table public.agent_threads
  add column resource_type text not null default 'lesson_file',
  add column semester_framework_id uuid,
  add column starter_suggestions_resource_version integer;

alter table public.agent_threads
  alter column lesson_file_id drop not null,
  add constraint agent_threads_resource_type_check
    check (resource_type in ('lesson_file', 'semester_framework')),
  add constraint agent_threads_resource_shape_check check (
    (resource_type = 'lesson_file'
      and lesson_file_id is not null
      and semester_framework_id is null)
    or
    (resource_type = 'semester_framework'
      and lesson_file_id is null
      and semester_framework_id is not null)
  ),
  add constraint agent_threads_owner_notebook_file_fkey
    foreign key (owner_id, notebook_id, lesson_file_id)
    references public.lesson_files(owner_id, notebook_id, id)
    on delete cascade,
  add constraint agent_threads_owner_notebook_framework_fkey
    foreign key (owner_id, notebook_id, semester_framework_id)
    references public.semester_frameworks(owner_id, notebook_id, id)
    on delete cascade;

update public.agent_threads
set starter_suggestions_resource_version = starter_suggestions_document_version
where starter_suggestions_resource_version is null;

create index agent_threads_framework_fk_idx
  on public.agent_threads(owner_id, semester_framework_id)
  where resource_type = 'semester_framework';
create index agent_threads_resource_lookup_idx
  on public.agent_threads(owner_id, resource_type, lesson_file_id, semester_framework_id, updated_at desc)
  where deleted_at is null;

alter table public.agent_approvals
  add column resource_type text,
  add column lesson_file_id text,
  add column semester_framework_id uuid,
  add column patch_kind text,
  add column base_resource_version integer;

update public.agent_approvals approval
set resource_type = thread.resource_type,
    lesson_file_id = thread.lesson_file_id,
    semester_framework_id = thread.semester_framework_id,
    patch_kind = 'document',
    base_resource_version = approval.document_version
from public.agent_threads thread
where thread.owner_id = approval.owner_id
  and thread.id = approval.thread_id;

alter table public.agent_approvals
  alter column document_version drop not null,
  alter column resource_type set not null,
  alter column patch_kind set not null,
  alter column base_resource_version set not null,
  add constraint agent_approvals_resource_type_check
    check (resource_type in ('lesson_file', 'semester_framework')),
  add constraint agent_approvals_patch_kind_check
    check (patch_kind in ('document', 'semester_framework', 'lesson_blueprint')),
  add constraint agent_approvals_base_resource_version_check
    check (base_resource_version >= 0),
  add constraint agent_approvals_resource_shape_check check (
    (resource_type = 'lesson_file'
      and patch_kind = 'document'
      and lesson_file_id is not null
      and semester_framework_id is null
      and document_version is not null)
    or
    (resource_type = 'semester_framework'
      and patch_kind in ('semester_framework', 'lesson_blueprint')
      and lesson_file_id is null
      and semester_framework_id is not null
      and document_version is null)
  ),
  add constraint agent_approvals_owner_file_fkey
    foreign key (owner_id, lesson_file_id)
    references public.lesson_files(owner_id, id)
    on delete cascade,
  add constraint agent_approvals_owner_framework_fkey
    foreign key (owner_id, semester_framework_id)
    references public.semester_frameworks(owner_id, id)
    on delete cascade;

create index agent_approvals_resource_idx
  on public.agent_approvals(
    owner_id, resource_type, lesson_file_id, semester_framework_id, created_at desc
  );

create or replace function public.bind_agent_approval_resource()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  scoped_thread public.agent_threads%rowtype;
begin
  select * into scoped_thread
  from public.agent_threads thread
  where thread.owner_id = new.owner_id and thread.id = new.thread_id;
  if not found then raise exception 'thread_not_found'; end if;

  new.resource_type := coalesce(new.resource_type, scoped_thread.resource_type);
  new.lesson_file_id := coalesce(new.lesson_file_id, scoped_thread.lesson_file_id);
  new.semester_framework_id := coalesce(
    new.semester_framework_id,
    scoped_thread.semester_framework_id
  );
  new.patch_kind := coalesce(
    new.patch_kind,
    case when scoped_thread.resource_type = 'lesson_file'
      then 'document' else 'semester_framework' end
  );
  new.base_resource_version := coalesce(new.base_resource_version, new.document_version);

  if new.resource_type is distinct from scoped_thread.resource_type
    or new.lesson_file_id is distinct from scoped_thread.lesson_file_id
    or new.semester_framework_id is distinct from scoped_thread.semester_framework_id
  then
    raise exception 'approval_resource_scope_mismatch';
  end if;
  if new.base_resource_version is null then
    raise exception 'approval_resource_version_missing';
  end if;
  return new;
end;
$$;

create trigger agent_approval_resource_binding
before insert or update of thread_id, resource_type, lesson_file_id,
  semester_framework_id, patch_kind, base_resource_version, document_version
on public.agent_approvals
for each row execute function public.bind_agent_approval_resource();

create or replace function public.create_agent_resource_thread(
  p_owner_id uuid,
  p_thread_id uuid,
  p_branch_id uuid,
  p_notebook_id text,
  p_resource_type text,
  p_lesson_file_id text,
  p_semester_framework_id uuid,
  p_title text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  created_thread public.agent_threads;
  created_branch public.agent_branches;
  request_hash text;
begin
  perform public.assert_service_scope(p_owner_id);
  if not (
    (p_resource_type = 'lesson_file'
      and p_lesson_file_id is not null
      and p_semester_framework_id is null)
    or
    (p_resource_type = 'semester_framework'
      and p_lesson_file_id is null
      and p_semester_framework_id is not null)
  ) then
    raise exception 'agent_resource_scope_invalid';
  end if;

  request_hash := encode(extensions.digest(jsonb_build_object(
    'notebookId', p_notebook_id,
    'resourceType', p_resource_type,
    'lessonFileId', p_lesson_file_id,
    'semesterFrameworkId', p_semester_framework_id,
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

  if p_resource_type = 'lesson_file' and not exists (
    select 1 from public.lesson_files file
    where file.owner_id = p_owner_id
      and file.notebook_id = p_notebook_id
      and file.id = p_lesson_file_id
  ) then
    raise exception 'lesson_file_not_found';
  end if;
  if p_resource_type = 'semester_framework' and not exists (
    select 1 from public.semester_frameworks framework
    where framework.owner_id = p_owner_id
      and framework.notebook_id = p_notebook_id
      and framework.id = p_semester_framework_id
  ) then
    raise exception 'semester_framework_not_found';
  end if;

  insert into public.agent_threads(
    id, owner_id, notebook_id, resource_type, lesson_file_id,
    semester_framework_id, title, create_idempotency_key, create_request_hash
  ) values (
    p_thread_id, p_owner_id, p_notebook_id, p_resource_type, p_lesson_file_id,
    p_semester_framework_id, p_title, p_idempotency_key, request_hash
  ) returning * into created_thread;

  insert into public.agent_branches(id, owner_id, thread_id, label)
  values (p_branch_id, p_owner_id, p_thread_id, '主分支')
  returning * into created_branch;

  return jsonb_build_object('thread', to_jsonb(created_thread), 'branch', to_jsonb(created_branch));
end;
$$;

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
language sql
security definer
set search_path = public
as $$
  select public.create_agent_resource_thread(
    p_owner_id, p_thread_id, p_branch_id, p_notebook_id,
    'lesson_file', p_lesson_file_id, null, p_title, p_idempotency_key
  );
$$;

revoke all on function public.create_agent_resource_thread(
  uuid, uuid, uuid, text, text, text, uuid, text, text
), public.create_agent_thread(uuid, uuid, uuid, text, text, text, text)
from public, anon, authenticated;
grant execute on function public.create_agent_resource_thread(
  uuid, uuid, uuid, text, text, text, uuid, text, text
), public.create_agent_thread(uuid, uuid, uuid, text, text, text, text)
to service_role;
