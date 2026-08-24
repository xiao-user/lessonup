create table if not exists public.curriculum_standard_releases (
  id uuid primary key,
  series_key text not null,
  release_key text not null unique,
  title text not null,
  version_label text not null,
  authority text not null,
  issued_year integer check (issued_year is null or issued_year between 1900 and 2200),
  expected_document_count integer not null check (expected_document_count between 1 and 64),
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  metadata jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists curriculum_standard_one_published_series
  on public.curriculum_standard_releases(series_key)
  where status = 'published';

create table if not exists public.curriculum_standard_documents (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.curriculum_standard_releases(id) on delete cascade,
  knowledge_source_id uuid not null unique references public.knowledge_sources(id) on delete restrict,
  filename text not null,
  title text not null,
  subject text not null,
  stage_scope text[] not null,
  grade_scope text[] not null default '{}',
  standard_code text,
  source_url text,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(release_id, filename),
  unique(release_id, file_sha256)
);

create index if not exists curriculum_standard_documents_release_fk
  on public.curriculum_standard_documents(release_id);
create index if not exists curriculum_standard_documents_scope
  on public.curriculum_standard_documents(subject, release_id);
create index if not exists curriculum_standard_documents_stages
  on public.curriculum_standard_documents using gin(stage_scope);
create index if not exists curriculum_standard_documents_grades
  on public.curriculum_standard_documents using gin(grade_scope);

create unique index if not exists knowledge_sources_platform_idempotency
  on public.knowledge_sources(upload_idempotency_key)
  where owner_id is null and upload_idempotency_key is not null;

alter table public.curriculum_standard_releases enable row level security;
alter table public.curriculum_standard_documents enable row level security;

create policy curriculum_standard_releases_published_read
  on public.curriculum_standard_releases for select to authenticated
  using (status = 'published');
create policy curriculum_standard_documents_published_read
  on public.curriculum_standard_documents for select to authenticated
  using (exists (
    select 1 from public.curriculum_standard_releases release
    where release.id = curriculum_standard_documents.release_id and release.status = 'published'
  ));

revoke insert, update, delete on public.curriculum_standard_releases from anon, authenticated;
revoke insert, update, delete on public.curriculum_standard_documents from anon, authenticated;
grant select on public.curriculum_standard_releases, public.curriculum_standard_documents to authenticated;
grant select, insert, update, delete on public.curriculum_standard_releases, public.curriculum_standard_documents to service_role;

create or replace function public.upsert_curriculum_standard_document(
  p_release jsonb,
  p_document jsonb,
  p_source_id uuid,
  p_storage_key text,
  p_file_sha256 text
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
  stage_scope text[];
  grade_scope text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'curriculum_standard_import_denied' using errcode = '42501';
  end if;
  if v_release_key is null or v_filename is null or p_storage_key is null
    or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'curriculum_standard_import_invalid';
  end if;

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
  if not found or release.id <> release_id then raise exception 'curriculum_standard_release_identity_conflict'; end if;

  select * into existing_document
  from public.curriculum_standard_documents document
  where document.release_id = release.id and document.filename = v_filename;
  if found then
    if existing_document.file_sha256 <> p_file_sha256 then
      raise exception 'curriculum_standard_published_filename_changed';
    end if;
    select * into source from public.knowledge_sources where id = existing_document.knowledge_source_id;
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
    storage_key, source_url, status, metadata, upload_idempotency_key
  ) values (
    p_source_id, null, null, null, 'public', p_document->>'title', 'application/pdf',
    p_storage_key, nullif(p_document->>'sourceUrl', ''), 'queued',
    jsonb_build_object(
      'contentType', 'curriculum_standard',
      'releaseKey', release.release_key,
      'subject', p_document->>'subject',
      'stageScope', to_jsonb(stage_scope),
      'gradeScope', to_jsonb(grade_scope),
      'standardCode', nullif(p_document->>'standardCode', ''),
      'originalFilename', v_filename,
      'sha256', p_file_sha256
    ),
    'curriculum-standard:' || release.release_key || ':' || p_file_sha256
  ) returning * into source;

  insert into public.curriculum_standard_documents(
    release_id, knowledge_source_id, filename, title, subject, stage_scope, grade_scope,
    standard_code, source_url, file_sha256
  ) values (
    release.id, p_source_id, v_filename, p_document->>'title', p_document->>'subject',
    stage_scope, grade_scope, nullif(p_document->>'standardCode', ''),
    nullif(p_document->>'sourceUrl', ''), p_file_sha256
  );

  insert into public.knowledge_audit_events(owner_id, source_id, action, details)
  values (null, p_source_id, 'curriculum_standard.queued', jsonb_build_object(
    'releaseKey', release.release_key, 'filename', v_filename, 'sha256', p_file_sha256
  ));
  return source;
end
$$;

create or replace function public.publish_curriculum_standard_release(p_release_key text)
returns public.curriculum_standard_releases
language plpgsql
security definer
set search_path = public
as $$
declare
  release public.curriculum_standard_releases;
  document_count integer;
  ready_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'curriculum_standard_publish_denied' using errcode = '42501';
  end if;
  select * into release from public.curriculum_standard_releases
  where release_key = p_release_key for update;
  if not found then raise exception 'curriculum_standard_release_not_found'; end if;
  if release.status = 'published' then return release; end if;
  if release.status <> 'draft' then raise exception 'curriculum_standard_release_not_publishable'; end if;

  select count(*), count(*) filter (where source.status = 'ready')
  into document_count, ready_count
  from public.curriculum_standard_documents document
  join public.knowledge_sources source on source.id = document.knowledge_source_id
  where document.release_id = release.id;
  if document_count <> release.expected_document_count then
    raise exception 'curriculum_standard_document_count_incomplete';
  end if;
  if ready_count <> document_count then raise exception 'curriculum_standard_index_incomplete'; end if;

  update public.curriculum_standard_releases
  set status = 'retired', updated_at = now()
  where series_key = release.series_key and status = 'published' and id <> release.id;
  update public.curriculum_standard_releases
  set status = 'published', published_at = now(), updated_at = now()
  where id = release.id returning * into release;

  insert into public.knowledge_audit_events(owner_id, source_id, action, details)
  values (null, null, 'curriculum_standard.published', jsonb_build_object(
    'releaseId', release.id, 'releaseKey', release.release_key, 'documentCount', document_count
  ));
  return release;
end
$$;

create or replace function public.curriculum_standard_source_is_published(p_source_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.curriculum_standard_documents where knowledge_source_id = p_source_id
  ) or exists (
    select 1
    from public.curriculum_standard_documents document
    join public.curriculum_standard_releases release on release.id = document.release_id
    where document.knowledge_source_id = p_source_id and release.status = 'published'
  );
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
    where release.status = 'published'
      and source.status = 'ready'
      and document.subject = p_subject
      and (p_stage is null or p_stage = '' or p_stage = any(document.stage_scope))
      and (p_grade is null or p_grade = '' or cardinality(document.grade_scope) = 0 or p_grade = any(document.grade_scope))
  ) ranked
  order by ranked.rank_score desc
  limit least(8, greatest(1, p_limit));
$$;

-- Draft curriculum-standard sources are never visible through the generic knowledge MCP.
create or replace function public.search_knowledge_hybrid(
  p_owner_id uuid,p_scopes text[],p_query text,p_query_embedding vector(1024),p_limit integer default 6
) returns table(id text,title text,url text,kind text,page integer,"chunkId" text,passage text,score double precision,section text)
language sql security definer set search_path=public as $$
  select s.id::text,s.title,s.source_url,
    case when c.scope='public' then 'public' else 'private' end,c.page,c.stable_chunk_id,c.passage,
    (case when p_query_embedding is null then 0 else 1-(c.embedding <=> p_query_embedding) end
      + ts_rank_cd(c.keywords,plainto_tsquery('simple',p_query)))::double precision as score,c.section
  from public.knowledge_chunks c join public.knowledge_sources s on s.id=c.source_id
  where s.status='ready'
    and public.curriculum_standard_source_is_published(s.id)
    and (s.owner_id is null or s.attached_message_id is not null)
    and (c.owner_id=p_owner_id or c.owner_id is null)
    and (c.scope='public' or 'user:'||p_owner_id::text=any(p_scopes)
      or 'notebook:'||coalesce(c.notebook_id,'')=any(p_scopes)
      or 'file:'||coalesce(c.lesson_file_id,'')=any(p_scopes))
  order by score desc limit least(8,greatest(1,p_limit));
$$;

create or replace function public.get_scoped_knowledge_passage(p_owner_id uuid,p_scopes text[],p_chunk_id text)
returns table(id text,title text,url text,kind text,page integer,"chunkId" text,passage text,score double precision,section text)
language sql security definer set search_path=public as $$
  select s.id::text,s.title,s.source_url,case when c.scope='public' then 'public' else 'private' end,
    c.page,c.stable_chunk_id,concat_ws(E'\n',c.adjacent_before,c.passage,c.adjacent_after),1::double precision,c.section
  from public.knowledge_chunks c join public.knowledge_sources s on s.id=c.source_id
  where s.status='ready'
    and public.curriculum_standard_source_is_published(s.id)
    and (s.owner_id is null or s.attached_message_id is not null)
    and c.stable_chunk_id=p_chunk_id and (c.owner_id=p_owner_id or c.owner_id is null)
    and (c.scope='public' or 'user:'||p_owner_id::text=any(p_scopes)
      or 'notebook:'||coalesce(c.notebook_id,'')=any(p_scopes)
      or 'file:'||coalesce(c.lesson_file_id,'')=any(p_scopes));
$$;

create or replace function public.list_scoped_knowledge_sources(p_owner_id uuid,p_scopes text[])
returns table(id text,title text,url text,kind text)
language sql security definer set search_path=public as $$
  select distinct s.id::text,s.title,s.source_url,case when s.scope='public' then 'public' else 'private' end
  from public.knowledge_sources s
  where s.status='ready'
    and public.curriculum_standard_source_is_published(s.id)
    and (s.owner_id is null or s.attached_message_id is not null)
    and (s.owner_id=p_owner_id or s.owner_id is null)
    and (s.scope='public' or 'user:'||p_owner_id::text=any(p_scopes)
      or 'notebook:'||coalesce(s.notebook_id,'')=any(p_scopes)
      or 'file:'||coalesce(s.lesson_file_id,'')=any(p_scopes));
$$;

create or replace function public.get_scoped_knowledge_source_passages(
  p_owner_id uuid,p_scopes text[],p_source_id uuid,p_limit integer default 8
)
returns table(id text,title text,url text,kind text,page integer,"chunkId" text,passage text,score double precision,section text)
language sql security definer set search_path=public as $$
  select source.id::text,source.title,source.source_url,
    case when chunk.scope='public' then 'public' else 'private' end,
    chunk.page,chunk.stable_chunk_id,chunk.passage,1::double precision,chunk.section
  from public.knowledge_chunks chunk
  join public.knowledge_sources source on source.id=chunk.source_id
  where source.id=p_source_id
    and source.status='ready'
    and public.curriculum_standard_source_is_published(source.id)
    and (source.owner_id is null or source.attached_message_id is not null)
    and (chunk.owner_id=p_owner_id or chunk.owner_id is null)
    and (chunk.scope='public' or 'user:'||p_owner_id::text=any(p_scopes)
      or 'notebook:'||coalesce(chunk.notebook_id,'')=any(p_scopes)
      or 'file:'||coalesce(chunk.lesson_file_id,'')=any(p_scopes))
  order by chunk.created_at,chunk.id
  limit least(12,greatest(1,p_limit));
$$;

revoke all on function public.upsert_curriculum_standard_document(jsonb,jsonb,uuid,text,text),
  public.publish_curriculum_standard_release(text),
  public.curriculum_standard_source_is_published(uuid),
  public.search_curriculum_standards(text,vector,text,text,text,integer)
from public, anon, authenticated;
grant execute on function public.upsert_curriculum_standard_document(jsonb,jsonb,uuid,text,text),
  public.publish_curriculum_standard_release(text),
  public.search_curriculum_standards(text,vector,text,text,text,integer)
to service_role;
grant execute on function public.curriculum_standard_source_is_published(uuid) to service_role;
