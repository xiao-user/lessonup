create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists public.notebooks (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  title text not null,
  class_name text not null,
  year text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create table if not exists public.lesson_files (
  owner_id uuid not null,
  id text not null,
  notebook_id text not null,
  title text not null,
  type text not null default '教案',
  image text,
  document jsonb not null,
  document_version integer not null default 0 check (document_version >= 0),
  page_count integer not null default 1 check (page_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  foreign key (owner_id, notebook_id) references public.notebooks(owner_id, id) on delete cascade
);

create table if not exists public.lesson_file_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  lesson_file_id text not null,
  document_version integer not null,
  document jsonb not null,
  page_count integer not null,
  actor text not null check (actor in ('manual', 'agent', 'undo', 'import')),
  run_id uuid,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  foreign key (owner_id, lesson_file_id) references public.lesson_files(owner_id, id) on delete cascade,
  unique (owner_id, idempotency_key),
  unique (owner_id, lesson_file_id, document_version)
);

create table if not exists public.agent_threads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  notebook_id text not null,
  lesson_file_id text not null,
  title text not null default '新会话',
  status text not null default 'idle' check (status in ('idle', 'running', 'awaiting_approval', 'failed')),
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, notebook_id) references public.notebooks(owner_id, id) on delete cascade,
  foreign key (owner_id, lesson_file_id) references public.lesson_files(owner_id, id) on delete cascade
);

create table if not exists public.agent_branches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.agent_threads(id) on delete cascade,
  parent_branch_id uuid references public.agent_branches(id),
  forked_from_message_id uuid,
  label text not null default '主分支',
  created_at timestamptz not null default now()
);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.agent_threads(id) on delete cascade,
  branch_id uuid not null references public.agent_branches(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  status text not null default 'completed' check (status in ('completed', 'streaming', 'failed')),
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.agent_branches drop constraint if exists agent_branches_forked_from_message_id_fkey;
alter table public.agent_branches add constraint agent_branches_forked_from_message_id_fkey
  foreign key (forked_from_message_id) references public.agent_messages(id) on delete set null;

create table if not exists public.agent_session_items (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.agent_threads(id) on delete cascade,
  branch_id uuid not null references public.agent_branches(id) on delete cascade,
  sequence bigint not null,
  item jsonb not null,
  created_at timestamptz not null default now(),
  unique (owner_id, thread_id, branch_id, sequence)
);

create table if not exists public.agent_thread_memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.agent_threads(id) on delete cascade,
  branch_id uuid not null references public.agent_branches(id) on delete cascade,
  summary text not null,
  summary_cursor bigint not null,
  updated_at timestamptz not null default now(),
  unique (owner_id, thread_id, branch_id)
);

create table if not exists public.agent_runs (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.agent_threads(id) on delete cascade,
  branch_id uuid not null references public.agent_branches(id) on delete cascade,
  model text not null,
  status text not null check (status in ('queued', 'running', 'awaiting_approval', 'completed', 'cancelled', 'failed')),
  capability_plan jsonb,
  agent_definition_version text,
  skill_versions jsonb not null default '{}'::jsonb,
  token_usage jsonb not null default '{}'::jsonb,
  provider_cost numeric,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.agent_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  type text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_approvals (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  thread_id uuid not null references public.agent_threads(id) on delete cascade,
  branch_id uuid not null references public.agent_branches(id) on delete cascade,
  state text not null check (state in ('pending', 'approved', 'rejected', 'expired')),
  patch jsonb not null,
  encrypted_run_state text not null,
  agent_definition_version text not null,
  document_version integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  notebook_id text,
  lesson_file_id text,
  scope text not null check (scope in ('public', 'user', 'notebook', 'file')),
  title text not null,
  media_type text not null,
  storage_key text,
  source_url text,
  source_version integer not null default 1,
  status text not null default 'queued' check (status in ('queued', 'processing', 'ready', 'failed', 'deleted')),
  index_version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.knowledge_sources(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete cascade,
  notebook_id text,
  lesson_file_id text,
  scope text not null,
  stable_chunk_id text not null unique,
  section text,
  page integer,
  passage text not null,
  adjacent_before text,
  adjacent_after text,
  keywords tsvector generated always as (to_tsvector('simple', passage)) stored,
  embedding vector(1024),
  index_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_audit_events (
  id bigint generated always as identity primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  source_id uuid references public.knowledge_sources(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into storage.buckets (id, name, public, file_size_limit)
values ('knowledge-private', 'knowledge-private', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create index if not exists agent_messages_branch_time on public.agent_messages(owner_id, thread_id, branch_id, created_at);
create index if not exists agent_runs_thread_status on public.agent_runs(owner_id, thread_id, status);
create unique index if not exists agent_runs_one_active_thread on public.agent_runs(owner_id, thread_id)
  where status in ('queued','running','awaiting_approval');
create index if not exists knowledge_chunks_keywords on public.knowledge_chunks using gin(keywords);
create index if not exists knowledge_chunks_embedding on public.knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- Foreign-key indexes keep project deletion, archival, and branch cleanup predictable as data grows.
create index if not exists lesson_files_notebook_fk on public.lesson_files(owner_id, notebook_id);
create index if not exists agent_threads_notebook_fk on public.agent_threads(owner_id, notebook_id);
create index if not exists agent_threads_lesson_file_fk on public.agent_threads(owner_id, lesson_file_id);
create index if not exists agent_branches_thread_fk on public.agent_branches(thread_id);
create index if not exists agent_branches_parent_fk on public.agent_branches(parent_branch_id);
create index if not exists agent_branches_fork_message_fk on public.agent_branches(forked_from_message_id);
create index if not exists agent_messages_thread_fk on public.agent_messages(thread_id);
create index if not exists agent_messages_branch_fk on public.agent_messages(branch_id);
create index if not exists agent_session_items_thread_fk on public.agent_session_items(thread_id);
create index if not exists agent_session_items_branch_fk on public.agent_session_items(branch_id);
create index if not exists agent_thread_memories_thread_fk on public.agent_thread_memories(thread_id);
create index if not exists agent_thread_memories_branch_fk on public.agent_thread_memories(branch_id);
create index if not exists agent_runs_thread_fk on public.agent_runs(thread_id);
create index if not exists agent_runs_branch_fk on public.agent_runs(branch_id);
create index if not exists agent_events_run_fk on public.agent_events(run_id);
create index if not exists agent_approvals_run_fk on public.agent_approvals(run_id);
create index if not exists agent_approvals_thread_fk on public.agent_approvals(thread_id);
create index if not exists agent_approvals_branch_fk on public.agent_approvals(branch_id);
create index if not exists knowledge_chunks_source_fk on public.knowledge_chunks(source_id);
create index if not exists knowledge_audit_events_source_fk on public.knowledge_audit_events(source_id);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'notebooks','lesson_files','lesson_file_versions','agent_threads','agent_branches',
    'agent_messages','agent_session_items','agent_thread_memories','agent_runs','agent_events',
    'agent_approvals','knowledge_sources','knowledge_chunks','knowledge_audit_events'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists owner_isolation on public.%I', table_name);
    execute format(
      'create policy owner_isolation on public.%I for all using (owner_id = (select auth.uid()) or (owner_id is null and %L in (''knowledge_sources'',''knowledge_chunks''))) with check (owner_id = (select auth.uid()))',
      table_name, table_name
    );
  end loop;
end $$;

create or replace function public.assert_service_scope(p_owner_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from p_owner_id then
    raise exception 'scope_denied' using errcode = '42501';
  end if;
end $$;

create or replace function public.import_lessonup_notebooks(p_owner_id uuid, p_notebooks jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare notebook jsonb; file jsonb; imported integer := 0;
begin
  perform public.assert_service_scope(p_owner_id);
  for notebook in select * from jsonb_array_elements(p_notebooks) loop
    insert into public.notebooks(owner_id,id,title,class_name,year,subject)
    values (p_owner_id, notebook->>'id', notebook->>'title', notebook->>'className', notebook->>'year', notebook->>'subject')
    on conflict (owner_id,id) do update set
      title=excluded.title,class_name=excluded.class_name,year=excluded.year,subject=excluded.subject,updated_at=now();
    for file in select * from jsonb_array_elements(coalesce(notebook->'files','[]'::jsonb)) loop
      insert into public.lesson_files(owner_id,id,notebook_id,title,type,image,document,page_count)
      values (p_owner_id,file->>'id',notebook->>'id',file->>'title',coalesce(file->>'type','教案'),file->>'image',file->'lessonPlan',coalesce((file->>'pages')::integer,1))
      on conflict (owner_id,id) do nothing;
      if found then
        imported := imported + 1;
        insert into public.lesson_file_versions(owner_id,lesson_file_id,document_version,document,page_count,actor,idempotency_key)
        values (p_owner_id,file->>'id',0,file->'lessonPlan',coalesce((file->>'pages')::integer,1),'import','import:' || (file->>'id'));
      end if;
    end loop;
  end loop;
  return jsonb_build_object('imported', imported);
end $$;

create or replace function public.save_lesson_document(
  p_owner_id uuid,p_file_id text,p_base_version integer,p_document jsonb,p_page_count integer,
  p_source text,p_run_id uuid,p_idempotency_key text
) returns public.lesson_files language plpgsql security definer set search_path = public as $$
declare current_file public.lesson_files; existing_version public.lesson_file_versions;
begin
  perform public.assert_service_scope(p_owner_id);
  select * into existing_version from public.lesson_file_versions
    where owner_id=p_owner_id and idempotency_key=p_idempotency_key;
  if found then
    select * into current_file from public.lesson_files where owner_id=p_owner_id and id=p_file_id;
    return current_file;
  end if;
  select * into current_file from public.lesson_files where owner_id=p_owner_id and id=p_file_id for update;
  if not found then raise exception 'lesson_file_not_found'; end if;
  if current_file.document_version <> p_base_version then raise exception 'stale_document'; end if;
  update public.lesson_files set document=p_document,document_version=document_version+1,page_count=p_page_count,updated_at=now()
    where owner_id=p_owner_id and id=p_file_id returning * into current_file;
  insert into public.lesson_file_versions(owner_id,lesson_file_id,document_version,document,page_count,actor,run_id,idempotency_key)
  values (p_owner_id,p_file_id,current_file.document_version,p_document,p_page_count,p_source,p_run_id,p_idempotency_key);
  return current_file;
end $$;

create or replace function public.apply_approved_document_patch(p_owner_id uuid,p_approval_id uuid,p_idempotency_key text)
returns public.lesson_files language plpgsql security definer set search_path = public as $$
declare approval public.agent_approvals; current_file public.lesson_files; existing_version public.lesson_file_versions; operation jsonb; field_name text; source_text text; next_document jsonb;
begin
  perform public.assert_service_scope(p_owner_id);
  select * into existing_version from public.lesson_file_versions
    where owner_id=p_owner_id and idempotency_key=p_idempotency_key;
  if found then
    select * into current_file from public.lesson_files
      where owner_id=p_owner_id and id=existing_version.lesson_file_id;
    return current_file;
  end if;
  select * into approval from public.agent_approvals where owner_id=p_owner_id and id=p_approval_id for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.state <> 'pending' then raise exception 'approval_not_approvable'; end if;
  select * into current_file from public.lesson_files where owner_id=p_owner_id and id=approval.patch->>'fileId' for update;
  if current_file.document_version <> (approval.patch->>'baseDocumentVersion')::integer then raise exception 'stale_document'; end if;
  next_document := current_file.document;
  for operation in
    select value from jsonb_array_elements(approval.patch->'operations')
    order by value->>'field', (value->>'start')::integer desc
  loop
    field_name := operation->>'field';
    source_text := next_document->>field_name;
    if substring(source_text from (operation->>'start')::integer + 1 for (operation->>'end')::integer - (operation->>'start')::integer) <> operation->>'expectedText' then
      raise exception 'text_mismatch';
    end if;
    source_text := substring(source_text from 1 for (operation->>'start')::integer)
      || (operation->>'replacement')
      || substring(source_text from (operation->>'end')::integer + 1);
    next_document := jsonb_set(next_document,array[field_name],to_jsonb(source_text),false);
  end loop;
  current_file := public.save_lesson_document(p_owner_id,current_file.id,current_file.document_version,next_document,current_file.page_count,'agent',approval.run_id,p_idempotency_key);
  update public.agent_approvals set state='approved' where id=p_approval_id;
  return current_file;
end $$;

create or replace function public.append_agent_session_items(p_owner_id uuid,p_thread_id uuid,p_branch_id uuid,p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare item jsonb; next_sequence bigint;
begin
  perform public.assert_service_scope(p_owner_id);
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_thread_id::text || ':' || p_branch_id::text, 0));
  select coalesce(max(sequence),0) into next_sequence from public.agent_session_items
    where owner_id=p_owner_id and thread_id=p_thread_id and branch_id=p_branch_id;
  for item in select * from jsonb_array_elements(p_items) loop
    next_sequence := next_sequence + 1;
    insert into public.agent_session_items(owner_id,thread_id,branch_id,sequence,item)
    values (p_owner_id,p_thread_id,p_branch_id,next_sequence,item);
  end loop;
end $$;

create or replace function public.pop_agent_session_item(p_owner_id uuid,p_thread_id uuid,p_branch_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform public.assert_service_scope(p_owner_id);
  delete from public.agent_session_items where id=(select id from public.agent_session_items
    where owner_id=p_owner_id and thread_id=p_thread_id and branch_id=p_branch_id order by sequence desc limit 1)
  returning item into result;
  return result;
end $$;

create or replace function public.fork_agent_branch(p_owner_id uuid,p_thread_id uuid,p_parent_branch_id uuid,p_forked_from_message_id uuid)
returns public.agent_branches language plpgsql security definer set search_path = public as $$
declare branch public.agent_branches; fork_time timestamptz;
begin
  perform public.assert_service_scope(p_owner_id);
  if not exists(select 1 from public.agent_threads where id=p_thread_id and owner_id=p_owner_id) then raise exception 'thread_not_found'; end if;
  select created_at into fork_time from public.agent_messages where id=p_forked_from_message_id and owner_id=p_owner_id;
  insert into public.agent_branches(owner_id,thread_id,parent_branch_id,forked_from_message_id,label)
  values (p_owner_id,p_thread_id,p_parent_branch_id,p_forked_from_message_id,'分支') returning * into branch;
  insert into public.agent_messages(owner_id,thread_id,branch_id,role,content,status,sources,created_at)
  select owner_id,thread_id,branch.id,role,content,status,sources,created_at from public.agent_messages
    where owner_id=p_owner_id and thread_id=p_thread_id and branch_id=p_parent_branch_id
      and (fork_time is null or created_at <= fork_time) order by created_at;
  return branch;
end $$;

create or replace function public.search_knowledge_hybrid(
  p_owner_id uuid,p_scopes text[],p_query text,p_query_embedding vector(1024),p_limit integer default 6
) returns table(id text,title text,url text,kind text,page integer,"chunkId" text,passage text,score double precision,section text)
language sql security definer set search_path=public as $$
  select s.id::text,s.title,s.source_url,
    case when c.scope='public' then 'public' else 'private' end,c.page,c.stable_chunk_id,c.passage,
    (case when p_query_embedding is null then 0 else 1-(c.embedding <=> p_query_embedding) end
      + ts_rank_cd(c.keywords,plainto_tsquery('simple',p_query)))::double precision as score,c.section
  from public.knowledge_chunks c join public.knowledge_sources s on s.id=c.source_id
  where s.status='ready' and (c.owner_id=p_owner_id or c.owner_id is null)
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
  where s.status='ready' and c.stable_chunk_id=p_chunk_id and (c.owner_id=p_owner_id or c.owner_id is null)
    and (c.scope='public' or 'user:'||p_owner_id::text=any(p_scopes)
      or 'notebook:'||coalesce(c.notebook_id,'')=any(p_scopes)
      or 'file:'||coalesce(c.lesson_file_id,'')=any(p_scopes));
$$;

create or replace function public.list_scoped_knowledge_sources(p_owner_id uuid,p_scopes text[])
returns table(id text,title text,url text,kind text)
language sql security definer set search_path=public as $$
  select distinct s.id::text,s.title,s.source_url,case when s.scope='public' then 'public' else 'private' end
  from public.knowledge_sources s where s.status='ready' and (s.owner_id=p_owner_id or s.owner_id is null)
    and (s.scope='public' or 'user:'||p_owner_id::text=any(p_scopes)
      or 'notebook:'||coalesce(s.notebook_id,'')=any(p_scopes)
      or 'file:'||coalesce(s.lesson_file_id,'')=any(p_scopes));
$$;

create or replace function public.claim_knowledge_source()
returns setof public.knowledge_sources language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'worker_scope_denied' using errcode = '42501';
  end if;
  return query
    with candidate as (
      select id from public.knowledge_sources
      where status='queued' and storage_key is not null
      order by created_at
      for update skip locked
      limit 1
    )
    update public.knowledge_sources source
      set status='processing', updated_at=now()
      from candidate
      where source.id=candidate.id
      returning source.*;
end $$;

revoke all on function public.claim_knowledge_source() from public, anon, authenticated;
grant execute on function public.claim_knowledge_source() to service_role;

create or replace function public.publish_knowledge_index(
  p_source_id uuid,p_index_version text,p_chunks jsonb,p_metadata jsonb
) returns public.knowledge_sources language plpgsql security definer set search_path=public as $$
declare source public.knowledge_sources; chunk jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'worker_scope_denied' using errcode = '42501';
  end if;
  select * into source from public.knowledge_sources where id=p_source_id and status='processing' for update;
  if not found then raise exception 'knowledge_source_not_processing'; end if;
  if jsonb_array_length(p_chunks) = 0 then raise exception 'knowledge_source_empty'; end if;
  delete from public.knowledge_chunks where source_id=p_source_id;
  for chunk in select value from jsonb_array_elements(p_chunks) loop
    insert into public.knowledge_chunks(
      source_id,owner_id,notebook_id,lesson_file_id,scope,stable_chunk_id,section,page,
      passage,adjacent_before,adjacent_after,embedding,index_version
    ) values (
      p_source_id,source.owner_id,source.notebook_id,source.lesson_file_id,source.scope,
      chunk->>'stable_chunk_id',chunk->>'section',nullif(chunk->>'page','')::integer,
      chunk->>'passage',chunk->>'adjacent_before',chunk->>'adjacent_after',
      (chunk->>'embedding')::vector(1024),p_index_version
    );
  end loop;
  update public.knowledge_sources set
    status='ready',index_version=p_index_version,metadata=p_metadata,updated_at=now()
    where id=p_source_id returning * into source;
  insert into public.knowledge_audit_events(owner_id,source_id,action,details)
    values(source.owner_id,source.id,'index.ready',jsonb_build_object(
      'chunkCount',jsonb_array_length(p_chunks),'indexVersion',p_index_version
    ));
  return source;
end $$;

revoke all on function public.publish_knowledge_index(uuid,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.publish_knowledge_index(uuid,text,jsonb,jsonb) to service_role;

drop policy if exists lessonup_knowledge_owner on storage.objects;
create policy lessonup_knowledge_owner on storage.objects for all to authenticated
using (bucket_id='knowledge-private' and (storage.foldername(name))[1]=(select auth.uid())::text)
with check (bucket_id='knowledge-private' and (storage.foldername(name))[1]=(select auth.uid())::text);

-- Application data is served through the authenticated Hono API. Keep the Data API surface
-- server-only and grant the service role exactly what the repositories and workers require.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke execute on function public.assert_service_scope(uuid) from public, anon, authenticated;
revoke execute on function public.import_lessonup_notebooks(uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.save_lesson_document(uuid,text,integer,jsonb,integer,text,uuid,text) from public, anon, authenticated;
revoke execute on function public.apply_approved_document_patch(uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.append_agent_session_items(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.pop_agent_session_item(uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.fork_agent_branch(uuid,uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.search_knowledge_hybrid(uuid,text[],text,vector,integer) from public, anon, authenticated;
revoke execute on function public.get_scoped_knowledge_passage(uuid,text[],text) from public, anon, authenticated;
revoke execute on function public.list_scoped_knowledge_sources(uuid,text[]) from public, anon, authenticated;

grant execute on function public.assert_service_scope(uuid) to service_role;
grant execute on function public.import_lessonup_notebooks(uuid,jsonb) to service_role;
grant execute on function public.save_lesson_document(uuid,text,integer,jsonb,integer,text,uuid,text) to service_role;
grant execute on function public.apply_approved_document_patch(uuid,uuid,text) to service_role;
grant execute on function public.append_agent_session_items(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.pop_agent_session_item(uuid,uuid,uuid) to service_role;
grant execute on function public.fork_agent_branch(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.search_knowledge_hybrid(uuid,text[],text,vector,integer) to service_role;
grant execute on function public.get_scoped_knowledge_passage(uuid,text[],text) to service_role;
grant execute on function public.list_scoped_knowledge_sources(uuid,text[]) to service_role;
