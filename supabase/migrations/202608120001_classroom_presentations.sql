create table if not exists public.classroom_presentations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  notebook_id text not null,
  lesson_file_id text not null,
  title text not null check (char_length(title) between 1 and 160),
  theme text not null check (theme ~ '^theme(0[1-9]|1[0-2])$'),
  source_document_version integer not null check (source_document_version >= 0),
  blueprint_version integer not null default 0 check (blueprint_version >= 0),
  blueprint jsonb,
  ready_revision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, notebook_id)
    references public.notebooks(owner_id, id) on delete cascade,
  foreign key (owner_id, lesson_file_id)
    references public.lesson_files(owner_id, id) on delete cascade
);

create index if not exists classroom_presentations_lesson_file_idx
  on public.classroom_presentations(owner_id, lesson_file_id, updated_at desc);

create table if not exists public.classroom_presentation_revisions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  presentation_id uuid not null references public.classroom_presentations(id) on delete cascade,
  revision_no integer not null check (revision_no > 0),
  source_document_version integer not null check (source_document_version >= 0),
  source_document jsonb not null,
  blueprint_version integer not null check (blueprint_version >= 0),
  blueprint jsonb,
  status text not null default 'pending' check (status in ('pending', 'rendering', 'ready', 'failed')),
  planner_version text not null,
  skill_version text not null,
  dashi_version text not null,
  runtime_version text not null,
  dashi_goal jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (presentation_id, revision_no),
  unique (owner_id, id)
);

alter table public.classroom_presentations
  drop constraint if exists classroom_presentations_ready_revision_id_fkey;
alter table public.classroom_presentations
  add constraint classroom_presentations_ready_revision_id_fkey
  foreign key (ready_revision_id) references public.classroom_presentation_revisions(id) on delete set null;

create table if not exists public.classroom_presentation_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  presentation_id uuid not null references public.classroom_presentations(id) on delete cascade,
  revision_id uuid not null references public.classroom_presentation_revisions(id) on delete cascade,
  kind text not null check (kind in ('generate', 'render', 'export_pptx')),
  status text not null default 'queued' check (status in (
    'queued', 'planning', 'validating', 'rendering', 'qa', 'ready', 'failed', 'cancelled'
  )),
  progress integer not null default 0 check (progress between 0 and 100),
  stage_label text not null default '等待处理',
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  worker_id uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  available_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (owner_id, idempotency_key),
  unique (owner_id, id)
);

create index if not exists classroom_presentation_jobs_claim_idx
  on public.classroom_presentation_jobs(status, available_at, lease_expires_at, created_at)
  where status in ('queued', 'planning', 'validating', 'rendering', 'qa');

create table if not exists public.classroom_presentation_artifacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  presentation_id uuid not null references public.classroom_presentations(id) on delete cascade,
  revision_id uuid not null references public.classroom_presentation_revisions(id) on delete cascade,
  kind text not null check (kind in ('html_bundle', 'thumbnail', 'interaction_snapshot', 'pptx', 'dashi_goal')),
  storage_key text not null,
  media_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  checksum text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (revision_id, kind, storage_key),
  unique (owner_id, id)
);

create table if not exists public.classroom_presentation_revision_sessions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  revision_id uuid primary key references public.classroom_presentation_revisions(id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.classroom_presentations enable row level security;
alter table public.classroom_presentation_revisions enable row level security;
alter table public.classroom_presentation_jobs enable row level security;
alter table public.classroom_presentation_artifacts enable row level security;
alter table public.classroom_presentation_revision_sessions enable row level security;

drop policy if exists classroom_presentations_owner on public.classroom_presentations;
create policy classroom_presentations_owner on public.classroom_presentations
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists classroom_presentation_revisions_owner on public.classroom_presentation_revisions;
create policy classroom_presentation_revisions_owner on public.classroom_presentation_revisions
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists classroom_presentation_jobs_owner on public.classroom_presentation_jobs;
create policy classroom_presentation_jobs_owner on public.classroom_presentation_jobs
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists classroom_presentation_artifacts_owner on public.classroom_presentation_artifacts;
create policy classroom_presentation_artifacts_owner on public.classroom_presentation_artifacts
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists classroom_presentation_sessions_owner on public.classroom_presentation_revision_sessions;
create policy classroom_presentation_sessions_owner on public.classroom_presentation_revision_sessions
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit)
values ('presentation-private', 'presentation-private', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists presentation_private_owner_select on storage.objects;
create policy presentation_private_owner_select on storage.objects for select
  using (
    bucket_id = 'presentation-private'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create or replace function public.create_classroom_presentation(
  p_owner_id uuid,
  p_lesson_file_id text,
  p_expected_document_version integer,
  p_title text,
  p_theme text,
  p_preferred_page_count integer,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_file public.lesson_files%rowtype;
  v_existing public.classroom_presentation_jobs%rowtype;
  v_presentation_id uuid := gen_random_uuid();
  v_revision_id uuid := gen_random_uuid();
  v_job_id uuid := gen_random_uuid();
  v_signature jsonb := jsonb_build_object(
    'lessonFileId', p_lesson_file_id,
    'expectedDocumentVersion', p_expected_document_version,
    'title', p_title,
    'theme', p_theme,
    'preferredPageCount', p_preferred_page_count
  );
begin
  select * into v_existing from public.classroom_presentation_jobs
    where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.kind <> 'generate' or v_existing.metadata->'requestSignature' <> v_signature then
      raise exception 'idempotency_conflict';
    end if;
    return jsonb_build_object(
      'presentationId', v_existing.presentation_id,
      'revisionId', v_existing.revision_id,
      'jobId', v_existing.id
    );
  end if;

  select * into v_file from public.lesson_files
    where id = p_lesson_file_id and owner_id = p_owner_id
    for share;
  if not found then raise exception 'lesson_file_not_found'; end if;
  if v_file.document_version <> p_expected_document_version then raise exception 'stale_document'; end if;

  insert into public.classroom_presentations (
    id, owner_id, notebook_id, lesson_file_id, title, theme, source_document_version
  ) values (
    v_presentation_id, p_owner_id, v_file.notebook_id, v_file.id,
    p_title, p_theme, v_file.document_version
  );
  insert into public.classroom_presentation_revisions (
    id, owner_id, presentation_id, revision_no, source_document_version,
    source_document, blueprint_version, planner_version, skill_version,
    dashi_version, runtime_version
  ) values (
    v_revision_id, p_owner_id, v_presentation_id, 1, v_file.document_version,
    v_file.document, 1, 'classroom-presentation-planner@1.0.0',
    'classroom-presentation-design@1.0.0', '0.4.11',
    'lessonup-presentation-runtime@1.0.0'
  );
  insert into public.classroom_presentation_jobs (
    id, owner_id, presentation_id, revision_id, kind, stage_label,
    metadata, idempotency_key
  ) values (
    v_job_id, p_owner_id, v_presentation_id, v_revision_id, 'generate', '等待规划',
    jsonb_build_object('preferredPageCount', p_preferred_page_count, 'requestSignature', v_signature),
    p_idempotency_key
  );
  return jsonb_build_object(
    'presentationId', v_presentation_id,
    'revisionId', v_revision_id,
    'jobId', v_job_id
  );
end;
$$;

create or replace function public.enqueue_classroom_presentation_render(
  p_owner_id uuid,
  p_presentation_id uuid,
  p_blueprint_version integer,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_presentation public.classroom_presentations%rowtype;
  v_existing public.classroom_presentation_jobs%rowtype;
  v_revision_id uuid := gen_random_uuid();
  v_job_id uuid := gen_random_uuid();
  v_revision_no integer;
  v_signature jsonb := jsonb_build_object('presentationId', p_presentation_id, 'blueprintVersion', p_blueprint_version);
begin
  select * into v_existing from public.classroom_presentation_jobs
    where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.kind <> 'render' or v_existing.metadata->'requestSignature' <> v_signature then
      raise exception 'idempotency_conflict';
    end if;
    return jsonb_build_object('revisionId', v_existing.revision_id, 'jobId', v_existing.id);
  end if;
  select * into v_presentation from public.classroom_presentations
    where id = p_presentation_id and owner_id = p_owner_id for update;
  if not found then raise exception 'presentation_not_found'; end if;
  if v_presentation.blueprint is null or v_presentation.blueprint_version <> p_blueprint_version then
    raise exception 'presentation_blueprint_conflict';
  end if;
  select coalesce(max(revision_no), 0) + 1 into v_revision_no
    from public.classroom_presentation_revisions where presentation_id = p_presentation_id;
  insert into public.classroom_presentation_revisions (
    id, owner_id, presentation_id, revision_no, source_document_version,
    source_document, blueprint_version, blueprint, planner_version, skill_version,
    dashi_version, runtime_version
  ) values (
    v_revision_id, p_owner_id, p_presentation_id, v_revision_no,
    (v_presentation.blueprint->'source'->>'documentVersion')::integer,
    v_presentation.blueprint->'source'->'document', p_blueprint_version,
    v_presentation.blueprint, 'classroom-presentation-planner@1.0.0',
    'classroom-presentation-design@1.0.0', '0.4.11',
    'lessonup-presentation-runtime@1.0.0'
  );
  insert into public.classroom_presentation_jobs (
    id, owner_id, presentation_id, revision_id, kind, stage_label,
    metadata, idempotency_key
  ) values (
    v_job_id, p_owner_id, p_presentation_id, v_revision_id, 'render', '等待渲染',
    jsonb_build_object('requestSignature', v_signature), p_idempotency_key
  );
  return jsonb_build_object('revisionId', v_revision_id, 'jobId', v_job_id);
end;
$$;

create or replace function public.enqueue_classroom_presentation_export(
  p_owner_id uuid,
  p_presentation_id uuid,
  p_revision_id uuid,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.classroom_presentation_jobs%rowtype;
  v_revision public.classroom_presentation_revisions%rowtype;
  v_job_id uuid := gen_random_uuid();
  v_signature jsonb := jsonb_build_object('presentationId', p_presentation_id, 'revisionId', p_revision_id);
begin
  select * into v_existing from public.classroom_presentation_jobs
    where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.kind <> 'export_pptx' or v_existing.metadata->'requestSignature' <> v_signature then
      raise exception 'idempotency_conflict';
    end if;
    return v_existing.id;
  end if;
  select * into v_revision from public.classroom_presentation_revisions
    where id = p_revision_id and owner_id = p_owner_id
      and presentation_id = p_presentation_id and status = 'ready' and blueprint is not null;
  if not found then raise exception 'presentation_revision_not_exportable'; end if;
  insert into public.classroom_presentation_jobs (
    id, owner_id, presentation_id, revision_id, kind, stage_label,
    metadata, idempotency_key, max_attempts
  ) values (
    v_job_id, p_owner_id, p_presentation_id, p_revision_id, 'export_pptx', '等待静态化',
    jsonb_build_object('requestSignature', v_signature), p_idempotency_key, 2
  );
  return v_job_id;
end;
$$;

create or replace function public.claim_classroom_presentation_job(
  p_worker_id uuid,
  p_lease_seconds integer default 120
) returns setof public.classroom_presentation_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select id
    from public.classroom_presentation_jobs
    where available_at <= now()
      and attempt_count < max_attempts
      and (
        status = 'queued'
        or (status in ('planning', 'validating', 'rendering', 'qa') and lease_expires_at < now())
      )
    order by created_at
    for update skip locked
    limit 1
  )
  update public.classroom_presentation_jobs job set
    status = case when job.kind = 'generate' then 'planning' else 'rendering' end,
    stage_label = case
      when job.kind = 'generate' then '正在规划课堂演示'
      when job.kind = 'render' then '正在渲染演示'
      else '正在静态化'
    end,
    progress = greatest(job.progress, 5),
    attempt_count = job.attempt_count + 1,
    worker_id = p_worker_id,
    heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 600))),
    error = null,
    updated_at = now()
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

create or replace function public.publish_classroom_presentation_revision(
  p_job_id uuid,
  p_worker_id uuid,
  p_revision_id uuid,
  p_blueprint jsonb,
  p_dashi_goal jsonb,
  p_planner_version text,
  p_skill_version text,
  p_dashi_version text,
  p_runtime_version text
) returns public.classroom_presentation_revisions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.classroom_presentation_jobs%rowtype;
  v_revision public.classroom_presentation_revisions%rowtype;
begin
  select * into v_job from public.classroom_presentation_jobs
    where id = p_job_id and worker_id = p_worker_id and revision_id = p_revision_id
    for update;
  if not found then raise exception 'presentation_job_lease_lost'; end if;
  if v_job.status not in ('planning', 'validating', 'rendering', 'qa') then
    raise exception 'presentation_job_not_publishable';
  end if;
  update public.classroom_presentation_revisions set
    blueprint = p_blueprint,
    source_document = p_blueprint->'source'->'document',
    source_document_version = (p_blueprint->'source'->>'documentVersion')::integer,
    dashi_goal = p_dashi_goal,
    status = 'ready',
    planner_version = p_planner_version,
    skill_version = p_skill_version,
    dashi_version = p_dashi_version,
    runtime_version = p_runtime_version,
    error = null,
    completed_at = now()
  where id = p_revision_id and owner_id = v_job.owner_id
  returning * into v_revision;
  if not found then raise exception 'presentation_revision_not_found'; end if;
  update public.classroom_presentations set
    blueprint = case when v_job.kind = 'generate' then p_blueprint else blueprint end,
    blueprint_version = case when v_job.kind = 'generate' then v_revision.blueprint_version else blueprint_version end,
    source_document_version = (p_blueprint->'source'->>'documentVersion')::integer,
    theme = p_blueprint->>'theme',
    ready_revision_id = p_revision_id,
    updated_at = now()
  where id = v_job.presentation_id and owner_id = v_job.owner_id;
  if not found then raise exception 'presentation_not_found'; end if;
  update public.classroom_presentation_jobs set
    status = 'ready', progress = 100, stage_label = '演示已就绪',
    lease_expires_at = null, heartbeat_at = now(), error = null,
    completed_at = now(), updated_at = now()
  where id = p_job_id and worker_id = p_worker_id;
  return v_revision;
end;
$$;

create or replace function public.fail_classroom_presentation_revision(
  p_job_id uuid,
  p_worker_id uuid,
  p_revision_id uuid,
  p_error text,
  p_retry_at timestamptz default null
) returns public.classroom_presentation_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.classroom_presentation_jobs%rowtype;
  v_retry boolean;
begin
  select * into v_job from public.classroom_presentation_jobs
    where id = p_job_id and worker_id = p_worker_id and revision_id = p_revision_id
    for update;
  if not found then raise exception 'presentation_job_lease_lost'; end if;
  v_retry := p_retry_at is not null and v_job.attempt_count < v_job.max_attempts;
  update public.classroom_presentation_jobs set
    status = case when v_retry then 'queued' else 'failed' end,
    stage_label = case when v_retry then '等待重试' else '生成失败' end,
    available_at = coalesce(p_retry_at, available_at),
    worker_id = null,
    lease_expires_at = null,
    heartbeat_at = now(),
    error = left(p_error, 2000),
    completed_at = case when v_retry then null else now() end,
    updated_at = now()
  where id = p_job_id
  returning * into v_job;
  if not v_retry and v_job.kind <> 'export_pptx' then
    update public.classroom_presentation_revisions set
      status = 'failed', error = left(p_error, 2000), completed_at = now()
    where id = p_revision_id and owner_id = v_job.owner_id;
  end if;
  return v_job;
end;
$$;

revoke all on function public.create_classroom_presentation(uuid,text,integer,text,text,integer,text) from public, authenticated;
revoke all on function public.enqueue_classroom_presentation_render(uuid,uuid,integer,text) from public, authenticated;
revoke all on function public.enqueue_classroom_presentation_export(uuid,uuid,uuid,text) from public, authenticated;
revoke all on function public.claim_classroom_presentation_job(uuid,integer) from public, authenticated;
revoke all on function public.publish_classroom_presentation_revision(uuid,uuid,uuid,jsonb,jsonb,text,text,text,text) from public, authenticated;
revoke all on function public.fail_classroom_presentation_revision(uuid,uuid,uuid,text,timestamptz) from public, authenticated;
grant execute on function public.create_classroom_presentation(uuid,text,integer,text,text,integer,text) to service_role;
grant execute on function public.enqueue_classroom_presentation_render(uuid,uuid,integer,text) to service_role;
grant execute on function public.enqueue_classroom_presentation_export(uuid,uuid,uuid,text) to service_role;
grant execute on function public.claim_classroom_presentation_job(uuid,integer) to service_role;
grant execute on function public.publish_classroom_presentation_revision(uuid,uuid,uuid,jsonb,jsonb,text,text,text,text) to service_role;
grant execute on function public.fail_classroom_presentation_revision(uuid,uuid,uuid,text,timestamptz) to service_role;
