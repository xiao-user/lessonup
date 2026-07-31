alter table public.knowledge_sources
  add column if not exists upload_idempotency_key text,
  add column if not exists attempt_count integer not null default 0 check (attempt_count >= 0),
  add column if not exists max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists lease_expires_at timestamptz,
  add column if not exists worker_id uuid,
  add column if not exists last_error text;

create unique index if not exists knowledge_sources_upload_idempotency
  on public.knowledge_sources(owner_id, upload_idempotency_key)
  where upload_idempotency_key is not null;
create index if not exists knowledge_sources_claim_queue
  on public.knowledge_sources(status, available_at, created_at)
  where storage_key is not null;

create table if not exists public.knowledge_chunk_staging (
  id bigint generated always as identity primary key,
  source_id uuid not null references public.knowledge_sources(id) on delete cascade,
  worker_id uuid not null,
  owner_id uuid references auth.users(id) on delete cascade,
  notebook_id text,
  lesson_file_id text,
  scope text not null,
  stable_chunk_id text not null,
  section text,
  page integer,
  passage text not null,
  adjacent_before text,
  adjacent_after text,
  embedding vector(1024),
  index_version text not null,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_chunk_staging_publish
  on public.knowledge_chunk_staging(source_id, worker_id, id);
alter table public.knowledge_chunk_staging enable row level security;
revoke all on public.knowledge_chunk_staging from anon, authenticated;
grant select, insert, update, delete on public.knowledge_chunk_staging to service_role;
grant usage, select on sequence public.knowledge_chunk_staging_id_seq to service_role;

create or replace function public.enqueue_knowledge_source(
  p_owner_id uuid,
  p_source_id uuid,
  p_notebook_id text,
  p_lesson_file_id text,
  p_scope text,
  p_title text,
  p_media_type text,
  p_storage_key text,
  p_metadata jsonb,
  p_idempotency_key text
)
returns public.knowledge_sources
language plpgsql
security definer
set search_path = public
as $$
declare
  source public.knowledge_sources;
begin
  perform public.assert_service_scope(p_owner_id);
  select * into source
  from public.knowledge_sources
  where owner_id = p_owner_id and upload_idempotency_key = p_idempotency_key;
  if found then return source; end if;

  insert into public.knowledge_sources(
    id, owner_id, notebook_id, lesson_file_id, scope, title, media_type,
    storage_key, status, metadata, upload_idempotency_key
  )
  values (
    p_source_id, p_owner_id, p_notebook_id, p_lesson_file_id, p_scope, p_title,
    p_media_type, p_storage_key, 'queued', p_metadata, p_idempotency_key
  )
  returning * into source;

  insert into public.knowledge_audit_events(owner_id, source_id, action, details)
  values (
    p_owner_id,
    source.id,
    'upload.queued',
    jsonb_build_object('scope', p_scope, 'storageKey', p_storage_key)
  );
  return source;
end
$$;

drop function if exists public.claim_knowledge_source();
create function public.claim_knowledge_source(p_worker_id uuid)
returns setof public.knowledge_sources
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'worker_scope_denied' using errcode = '42501';
  end if;

  update public.knowledge_sources
  set
    status = case when attempt_count < max_attempts then 'queued' else 'failed' end,
    available_at = now(),
    worker_id = null,
    lease_expires_at = null,
    last_error = coalesce(last_error, 'worker_lease_expired'),
    updated_at = now()
  where status = 'processing'
    and lease_expires_at is not null
    and lease_expires_at <= now();

  return query
    with candidate as (
      select id
      from public.knowledge_sources
      where status = 'queued'
        and storage_key is not null
        and available_at <= now()
        and attempt_count < max_attempts
      order by available_at, created_at
      for update skip locked
      limit 1
    )
    update public.knowledge_sources source
    set
      status = 'processing',
      attempt_count = source.attempt_count + 1,
      worker_id = p_worker_id,
      lease_expires_at = now() + interval '15 minutes',
      last_error = null,
      updated_at = now()
    from candidate
    where source.id = candidate.id
    returning source.*;
end
$$;

create or replace function public.heartbeat_knowledge_source(
  p_source_id uuid,
  p_worker_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'worker_scope_denied' using errcode = '42501';
  end if;
  update public.knowledge_sources
  set lease_expires_at = now() + interval '15 minutes', updated_at = now()
  where id = p_source_id and status = 'processing' and worker_id = p_worker_id;
  if not found then raise exception 'knowledge_worker_lease_lost'; end if;
end
$$;

create or replace function public.stage_knowledge_chunk_batch(
  p_source_id uuid,
  p_worker_id uuid,
  p_index_version text,
  p_chunks jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  source public.knowledge_sources;
  chunk jsonb;
  inserted_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'worker_scope_denied' using errcode = '42501';
  end if;
  select * into source
  from public.knowledge_sources
  where id = p_source_id
    and status = 'processing'
    and worker_id = p_worker_id
    and lease_expires_at > now()
  for update;
  if not found then raise exception 'knowledge_worker_lease_lost'; end if;

  for chunk in select value from jsonb_array_elements(p_chunks) loop
    insert into public.knowledge_chunk_staging(
      source_id, worker_id, owner_id, notebook_id, lesson_file_id, scope,
      stable_chunk_id, section, page, passage, adjacent_before, adjacent_after,
      embedding, index_version
    )
    values (
      source.id,
      p_worker_id,
      source.owner_id,
      source.notebook_id,
      source.lesson_file_id,
      source.scope,
      chunk->>'stable_chunk_id',
      chunk->>'section',
      nullif(chunk->>'page','')::integer,
      chunk->>'passage',
      chunk->>'adjacent_before',
      chunk->>'adjacent_after',
      (chunk->>'embedding')::vector(1024),
      p_index_version
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end
$$;

create or replace function public.publish_staged_knowledge_index(
  p_source_id uuid,
  p_worker_id uuid,
  p_index_version text,
  p_expected_count integer,
  p_metadata jsonb
)
returns public.knowledge_sources
language plpgsql
security definer
set search_path = public
as $$
declare
  source public.knowledge_sources;
  staged_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'worker_scope_denied' using errcode = '42501';
  end if;
  select * into source
  from public.knowledge_sources
  where id = p_source_id
    and status = 'processing'
    and worker_id = p_worker_id
    and lease_expires_at > now()
  for update;
  if not found then raise exception 'knowledge_worker_lease_lost'; end if;

  select count(*) into staged_count
  from public.knowledge_chunk_staging
  where source_id = p_source_id and worker_id = p_worker_id;
  if staged_count = 0 or staged_count <> p_expected_count then
    raise exception 'knowledge_staging_incomplete';
  end if;

  delete from public.knowledge_chunks where source_id = p_source_id;
  insert into public.knowledge_chunks(
    source_id, owner_id, notebook_id, lesson_file_id, scope, stable_chunk_id,
    section, page, passage, adjacent_before, adjacent_after, embedding, index_version
  )
  select
    source_id, owner_id, notebook_id, lesson_file_id, scope, stable_chunk_id,
    section, page, passage, adjacent_before, adjacent_after, embedding, index_version
  from public.knowledge_chunk_staging
  where source_id = p_source_id and worker_id = p_worker_id
  order by id;

  update public.knowledge_sources
  set
    status = 'ready',
    index_version = p_index_version,
    metadata = p_metadata,
    worker_id = null,
    lease_expires_at = null,
    last_error = null,
    updated_at = now()
  where id = p_source_id
  returning * into source;

  delete from public.knowledge_chunk_staging where source_id = p_source_id;
  insert into public.knowledge_audit_events(owner_id, source_id, action, details)
  values (
    source.owner_id,
    source.id,
    'index.ready',
    jsonb_build_object('chunkCount', staged_count, 'indexVersion', p_index_version)
  );
  return source;
end
$$;

create or replace function public.fail_knowledge_source(
  p_source_id uuid,
  p_worker_id uuid,
  p_error text
)
returns public.knowledge_sources
language plpgsql
security definer
set search_path = public
as $$
declare
  source public.knowledge_sources;
  next_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'worker_scope_denied' using errcode = '42501';
  end if;
  select * into source
  from public.knowledge_sources
  where id = p_source_id and status = 'processing' and worker_id = p_worker_id
  for update;
  if not found then raise exception 'knowledge_worker_lease_lost'; end if;

  next_status := case when source.attempt_count < source.max_attempts then 'queued' else 'failed' end;
  update public.knowledge_sources
  set
    status = next_status,
    available_at = now() + make_interval(
      secs => least(300, (10 * power(2, source.attempt_count - 1))::integer)
    ),
    worker_id = null,
    lease_expires_at = null,
    last_error = left(p_error, 500),
    metadata = source.metadata || jsonb_build_object(
      'error', left(p_error, 500),
      'failedAt', now()
    ),
    updated_at = now()
  where id = p_source_id
  returning * into source;

  delete from public.knowledge_chunk_staging where source_id = p_source_id;
  insert into public.knowledge_audit_events(owner_id, source_id, action, details)
  values (
    source.owner_id,
    source.id,
    case when next_status = 'queued' then 'index.retry_scheduled' else 'index.failed' end,
    jsonb_build_object('error', left(p_error, 500), 'attempt', source.attempt_count)
  );
  return source;
end
$$;

revoke execute on function public.enqueue_knowledge_source(
  uuid,uuid,text,text,text,text,text,text,jsonb,text
) from public, anon, authenticated;
revoke execute on function public.claim_knowledge_source(uuid)
  from public, anon, authenticated;
revoke execute on function public.heartbeat_knowledge_source(uuid,uuid)
  from public, anon, authenticated;
revoke execute on function public.stage_knowledge_chunk_batch(uuid,uuid,text,jsonb)
  from public, anon, authenticated;
revoke execute on function public.publish_staged_knowledge_index(uuid,uuid,text,integer,jsonb)
  from public, anon, authenticated;
revoke execute on function public.fail_knowledge_source(uuid,uuid,text)
  from public, anon, authenticated;

grant execute on function public.enqueue_knowledge_source(
  uuid,uuid,text,text,text,text,text,text,jsonb,text
) to service_role;
grant execute on function public.claim_knowledge_source(uuid) to service_role;
grant execute on function public.heartbeat_knowledge_source(uuid,uuid) to service_role;
grant execute on function public.stage_knowledge_chunk_batch(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.publish_staged_knowledge_index(uuid,uuid,text,integer,jsonb) to service_role;
grant execute on function public.fail_knowledge_source(uuid,uuid,text) to service_role;
