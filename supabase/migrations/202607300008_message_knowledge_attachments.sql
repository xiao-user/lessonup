alter table public.knowledge_sources
  add column if not exists attached_message_id uuid
    references public.agent_messages(id) on delete set null;

create index if not exists knowledge_sources_unattached_file
  on public.knowledge_sources(owner_id, lesson_file_id, updated_at desc)
  where attached_message_id is null and status <> 'deleted';

create index if not exists knowledge_sources_attached_message_fk
  on public.knowledge_sources(attached_message_id)
  where attached_message_id is not null;

create or replace function public.attach_knowledge_sources_to_message(
  p_owner_id uuid,
  p_lesson_file_id text,
  p_message_id uuid,
  p_source_ids uuid[]
)
returns table(id text, title text, url text, kind text)
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_count integer;
  available_count integer;
begin
  perform public.assert_service_scope(p_owner_id);
  expected_count := coalesce(cardinality(p_source_ids), 0);
  if expected_count = 0 then return; end if;

  if expected_count <> (
    select count(distinct source_id)
    from unnest(p_source_ids) as requested(source_id)
  ) then
    raise exception 'knowledge_attachment_unavailable';
  end if;

  if not exists (
    select 1
    from public.agent_messages message
    join public.agent_threads thread on thread.id = message.thread_id
    where message.id = p_message_id
      and message.owner_id = p_owner_id
      and message.role = 'user'
      and thread.owner_id = p_owner_id
      and thread.lesson_file_id = p_lesson_file_id
  ) then
    raise exception 'knowledge_attachment_unavailable';
  end if;

  perform 1
  from public.knowledge_sources source
  where source.id = any(p_source_ids)
    and source.owner_id = p_owner_id
    and source.lesson_file_id = p_lesson_file_id
    and source.status = 'ready'
    and source.attached_message_id is null
  for update;
  get diagnostics available_count = row_count;

  if available_count <> expected_count then
    raise exception 'knowledge_attachment_unavailable';
  end if;

  update public.knowledge_sources
  set attached_message_id = p_message_id,
      updated_at = now()
  where knowledge_sources.id = any(p_source_ids)
    and owner_id = p_owner_id
    and lesson_file_id = p_lesson_file_id
    and status = 'ready'
    and attached_message_id is null;

  return query
    select source.id::text,
      source.title,
      source.source_url,
      case when source.scope = 'public' then 'public' else 'private' end
    from public.knowledge_sources source
    where source.id = any(p_source_ids)
      and source.attached_message_id = p_message_id
    order by source.created_at;
end
$$;

create or replace function public.get_scoped_knowledge_source_passages(
  p_owner_id uuid,
  p_scopes text[],
  p_source_id uuid,
  p_limit integer default 8
)
returns table(
  id text,
  title text,
  url text,
  kind text,
  page integer,
  "chunkId" text,
  passage text,
  score double precision,
  section text
)
language sql
security definer
set search_path = public
as $$
  select source.id::text,
    source.title,
    source.source_url,
    case when chunk.scope = 'public' then 'public' else 'private' end,
    chunk.page,
    chunk.stable_chunk_id,
    chunk.passage,
    1::double precision,
    chunk.section
  from public.knowledge_chunks chunk
  join public.knowledge_sources source on source.id = chunk.source_id
  where source.id = p_source_id
    and source.status = 'ready'
    and (chunk.owner_id = p_owner_id or chunk.owner_id is null)
    and (
      chunk.scope = 'public'
      or 'user:' || p_owner_id::text = any(p_scopes)
      or 'notebook:' || coalesce(chunk.notebook_id, '') = any(p_scopes)
      or 'file:' || coalesce(chunk.lesson_file_id, '') = any(p_scopes)
    )
  order by chunk.created_at, chunk.id
  limit least(12, greatest(1, p_limit));
$$;

revoke execute on function public.attach_knowledge_sources_to_message(uuid,text,uuid,uuid[])
  from public, anon, authenticated;
revoke execute on function public.get_scoped_knowledge_source_passages(uuid,text[],uuid,integer)
  from public, anon, authenticated;
grant execute on function public.attach_knowledge_sources_to_message(uuid,text,uuid,uuid[])
  to service_role;
grant execute on function public.get_scoped_knowledge_source_passages(uuid,text[],uuid,integer)
  to service_role;
