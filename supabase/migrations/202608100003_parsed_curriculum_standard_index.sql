-- Curriculum standards are parsed outside LessonUp. Only normalized chunks and
-- embeddings enter Supabase; the original PDF and PaddleOCR JSON stay in the
-- external/offline archive.
alter table public.curriculum_standard_documents
  add column if not exists document_kind text not null default 'curriculum_standard'
    check (document_kind in ('curriculum_standard', 'curriculum_plan'));

alter table public.curriculum_standard_documents
  alter column subject drop not null;

alter table public.knowledge_chunks
  add column if not exists page_end integer,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.knowledge_chunk_staging
  add column if not exists page_end integer,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create or replace function public.upsert_parsed_curriculum_standard_document(
  p_release jsonb,
  p_document jsonb,
  p_source_id uuid,
  p_parsed_sha256 text,
  p_worker_id uuid,
  p_index_version text
)
returns public.knowledge_sources
language plpgsql
security definer
set search_path = public
as $$
declare
  release public.curriculum_standard_releases;
  source public.knowledge_sources;
  existing_document public.curriculum_standard_documents;
  release_id uuid := (p_release->>'id')::uuid;
  v_release_key text := nullif(trim(p_release->>'releaseKey'), '');
  v_filename text := nullif(trim(p_document->>'filename'), '');
  v_kind text := coalesce(nullif(trim(p_document->>'kind'), ''), 'curriculum_standard');
  v_subject text := nullif(trim(p_document->>'subject'), '');
  stage_scope text[];
  grade_scope text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'curriculum_standard_import_denied' using errcode = '42501';
  end if;
  if v_release_key is null or v_filename is null
    or p_parsed_sha256 !~ '^[0-9a-f]{64}$'
    or p_index_version is null or trim(p_index_version) = ''
    or v_kind not in ('curriculum_standard', 'curriculum_plan')
    or (v_kind = 'curriculum_standard' and v_subject is null) then
    raise exception 'curriculum_standard_import_invalid';
  end if;
  if v_kind = 'curriculum_plan' then v_subject := null; end if;

  insert into public.curriculum_standard_releases(
    id, series_key, release_key, title, version_label, authority, issued_year,
    expected_document_count, metadata
  ) values (
    release_id,
    p_release->>'seriesKey',
    v_release_key,
    p_release->>'title',
    p_release->>'versionLabel',
    p_release->>'authority',
    nullif(p_release->>'issuedYear', '')::integer,
    (p_release->>'expectedDocumentCount')::integer,
    p_release - array['id','seriesKey','releaseKey','title','versionLabel','authority','issuedYear','expectedDocumentCount']
  )
  on conflict (release_key) do nothing;

  select * into release
  from public.curriculum_standard_releases
  where curriculum_standard_releases.release_key = v_release_key
  for update;
  if not found or release.id <> release_id then
    raise exception 'curriculum_standard_release_identity_conflict';
  end if;

  select * into existing_document
  from public.curriculum_standard_documents document
  where document.release_id = release.id and document.filename = v_filename;
  if found then
    if existing_document.file_sha256 <> p_parsed_sha256 then
      raise exception 'curriculum_standard_published_filename_changed';
    end if;
    select * into source from public.knowledge_sources
    where id = existing_document.knowledge_source_id for update;
    if source.status = 'ready' and source.index_version = p_index_version then return source; end if;
    if release.status <> 'draft' then raise exception 'curriculum_standard_release_immutable'; end if;
    delete from public.knowledge_chunk_staging where source_id = source.id;
    update public.knowledge_sources
    set status = 'processing', media_type = 'application/vnd.lessonup.curriculum-standard+json',
      storage_key = null, worker_id = p_worker_id, lease_expires_at = now() + interval '15 minutes',
      attempt_count = attempt_count + 1, last_error = null, updated_at = now()
    where id = source.id returning * into source;
    return source;
  end if;
  if release.status <> 'draft' then raise exception 'curriculum_standard_release_immutable'; end if;

  select coalesce(array_agg(value), '{}'::text[]) into stage_scope
  from jsonb_array_elements_text(coalesce(p_document->'stageScope', '[]'::jsonb)) value;
  select coalesce(array_agg(value), '{}'::text[]) into grade_scope
  from jsonb_array_elements_text(coalesce(p_document->'gradeScope', '[]'::jsonb)) value;
  if cardinality(stage_scope) = 0 then raise exception 'curriculum_standard_stage_scope_required'; end if;

  insert into public.knowledge_sources(
    id, owner_id, notebook_id, lesson_file_id, scope, title, media_type,
    storage_key, source_url, status, metadata, upload_idempotency_key,
    worker_id, lease_expires_at, attempt_count
  ) values (
    p_source_id, null, null, null, 'public', p_document->>'title',
    'application/vnd.lessonup.curriculum-standard+json', null,
    nullif(p_document->>'sourceUrl', ''), 'processing',
    jsonb_build_object(
      'contentType', v_kind,
      'releaseKey', release.release_key,
      'subject', v_subject,
      'stageScope', to_jsonb(stage_scope),
      'gradeScope', to_jsonb(grade_scope),
      'standardCode', nullif(p_document->>'standardCode', ''),
      'originalFilename', v_filename,
      'parsedSha256', p_parsed_sha256,
      'rawArtifactStored', false
    ),
    'curriculum-standard:' || release.release_key || ':' || p_parsed_sha256,
    p_worker_id, now() + interval '15 minutes', 1
  ) returning * into source;

  insert into public.curriculum_standard_documents(
    release_id, knowledge_source_id, filename, title, subject, document_kind,
    stage_scope, grade_scope, standard_code, source_url, file_sha256
  ) values (
    release.id, p_source_id, v_filename, p_document->>'title', v_subject, v_kind,
    stage_scope, grade_scope, nullif(p_document->>'standardCode', ''),
    nullif(p_document->>'sourceUrl', ''), p_parsed_sha256
  );

  insert into public.knowledge_audit_events(owner_id, source_id, action, details)
  values (null, p_source_id, 'curriculum_standard.index_started', jsonb_build_object(
    'releaseKey', release.release_key,
    'filename', v_filename,
    'parsedSha256', p_parsed_sha256,
    'rawArtifactStored', false
  ));
  return source;
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
  select * into source from public.knowledge_sources
  where id = p_source_id and status = 'processing' and worker_id = p_worker_id
    and lease_expires_at > now() for update;
  if not found then raise exception 'knowledge_worker_lease_lost'; end if;

  for chunk in select value from jsonb_array_elements(p_chunks) loop
    insert into public.knowledge_chunk_staging(
      source_id, worker_id, owner_id, notebook_id, lesson_file_id, scope,
      stable_chunk_id, section, page, page_end, passage, adjacent_before, adjacent_after,
      embedding, index_version, metadata
    ) values (
      source.id, p_worker_id, source.owner_id, source.notebook_id, source.lesson_file_id,
      source.scope, chunk->>'stable_chunk_id', chunk->>'section',
      nullif(chunk->>'page','')::integer, nullif(chunk->>'page_end','')::integer,
      chunk->>'passage', chunk->>'adjacent_before', chunk->>'adjacent_after',
      (chunk->>'embedding')::vector(1024), p_index_version,
      coalesce(chunk->'metadata', '{}'::jsonb)
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
  select * into source from public.knowledge_sources
  where id = p_source_id and status = 'processing' and worker_id = p_worker_id
    and lease_expires_at > now() for update;
  if not found then raise exception 'knowledge_worker_lease_lost'; end if;

  select count(*) into staged_count from public.knowledge_chunk_staging
  where source_id = p_source_id and worker_id = p_worker_id;
  if staged_count = 0 or staged_count <> p_expected_count then
    raise exception 'knowledge_staging_incomplete';
  end if;

  delete from public.knowledge_chunks where source_id = p_source_id;
  insert into public.knowledge_chunks(
    source_id, owner_id, notebook_id, lesson_file_id, scope, stable_chunk_id,
    section, page, page_end, passage, adjacent_before, adjacent_after,
    embedding, index_version, metadata
  )
  select source_id, owner_id, notebook_id, lesson_file_id, scope, stable_chunk_id,
    section, page, page_end, passage, adjacent_before, adjacent_after,
    embedding, index_version, metadata
  from public.knowledge_chunk_staging
  where source_id = p_source_id and worker_id = p_worker_id
  order by id;

  update public.knowledge_sources
  set status = 'ready', index_version = p_index_version, metadata = p_metadata,
    worker_id = null, lease_expires_at = null, last_error = null, updated_at = now()
  where id = p_source_id returning * into source;

  delete from public.knowledge_chunk_staging where source_id = p_source_id;
  insert into public.knowledge_audit_events(owner_id, source_id, action, details)
  values (source.owner_id, source.id, 'index.ready', jsonb_build_object(
    'chunkCount', staged_count, 'indexVersion', p_index_version
  ));
  return source;
end
$$;

create or replace function public.search_curriculum_standards(
  p_query text,
  p_query_embedding vector(1024),
  p_subject text,
  p_stage text default null,
  p_grade text default null,
  p_limit integer default 6
)
returns table(id text,title text,url text,kind text,page integer,"chunkId" text,passage text,score double precision,section text)
language sql
security definer
set search_path = public
as $$
  select ranked.id, ranked.title, ranked.url, ranked.kind, ranked.page, ranked."chunkId",
    ranked.passage, ranked.rank_score, ranked.section
  from (
    select source.id::text as id, source.title, source.source_url as url, 'public'::text as kind,
      chunk.page, chunk.stable_chunk_id as "chunkId", chunk.passage,
      (case when p_query_embedding is null then 0 else greatest(0, 1 - (chunk.embedding <=> p_query_embedding)) end
        + ts_rank_cd(chunk.keywords, plainto_tsquery('simple', p_query)))::double precision as rank_score,
      chunk.section
    from public.curriculum_standard_documents document
    join public.curriculum_standard_releases release on release.id = document.release_id
    join public.knowledge_sources source on source.id = document.knowledge_source_id
    join public.knowledge_chunks chunk on chunk.source_id = source.id
    where release.status = 'published' and source.status = 'ready'
      and (document.subject = p_subject or document.document_kind = 'curriculum_plan')
      and (p_stage is null or p_stage = '' or p_stage = any(document.stage_scope))
      and (p_grade is null or p_grade = '' or cardinality(document.grade_scope) = 0 or p_grade = any(document.grade_scope))
  ) ranked
  order by ranked.rank_score desc
  limit least(8, greatest(1, p_limit));
$$;

revoke all on function public.upsert_parsed_curriculum_standard_document(jsonb,jsonb,uuid,text,uuid,text)
from public, anon, authenticated;
grant execute on function public.upsert_parsed_curriculum_standard_document(jsonb,jsonb,uuid,text,uuid,text)
to service_role;

