-- Unsent composer uploads are drafts, not project knowledge. They become
-- discoverable only after the run transaction binds them to a user message.

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
    and (s.owner_id is null or s.attached_message_id is not null)
    and (s.owner_id=p_owner_id or s.owner_id is null)
    and (s.scope='public' or 'user:'||p_owner_id::text=any(p_scopes)
      or 'notebook:'||coalesce(s.notebook_id,'')=any(p_scopes)
      or 'file:'||coalesce(s.lesson_file_id,'')=any(p_scopes));
$$;

create or replace function public.get_scoped_knowledge_source_passages(
  p_owner_id uuid,
  p_scopes text[],
  p_source_id uuid,
  p_limit integer default 8
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
    and (source.owner_id is null or source.attached_message_id is not null)
    and (chunk.owner_id=p_owner_id or chunk.owner_id is null)
    and (chunk.scope='public' or 'user:'||p_owner_id::text=any(p_scopes)
      or 'notebook:'||coalesce(chunk.notebook_id,'')=any(p_scopes)
      or 'file:'||coalesce(chunk.lesson_file_id,'')=any(p_scopes))
  order by chunk.created_at,chunk.id
  limit least(12,greatest(1,p_limit));
$$;

revoke execute on function public.search_knowledge_hybrid(uuid,text[],text,vector,integer) from public, anon, authenticated;
revoke execute on function public.get_scoped_knowledge_passage(uuid,text[],text) from public, anon, authenticated;
revoke execute on function public.list_scoped_knowledge_sources(uuid,text[]) from public, anon, authenticated;
revoke execute on function public.get_scoped_knowledge_source_passages(uuid,text[],uuid,integer) from public, anon, authenticated;
grant execute on function public.search_knowledge_hybrid(uuid,text[],text,vector,integer) to service_role;
grant execute on function public.get_scoped_knowledge_passage(uuid,text[],text) to service_role;
grant execute on function public.list_scoped_knowledge_sources(uuid,text[]) to service_role;
grant execute on function public.get_scoped_knowledge_source_passages(uuid,text[],uuid,integer) to service_role;
