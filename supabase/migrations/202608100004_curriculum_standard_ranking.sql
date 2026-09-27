create extension if not exists pg_trgm with schema extensions;

-- Keep dense BGE-M3 similarity as the primary signal. Chinese trigram overlap
-- recovers exact terminology that the `simple` text search configuration does
-- not segment, while a small intent-aware section prior prefers normative core
-- clauses over appendices unless the teacher explicitly asks for an example.
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
stable
security definer
set search_path = public
as $$
  with candidates as (
    select
      source.id::text as id,
      source.title,
      source.source_url as url,
      'public'::text as kind,
      chunk.page,
      chunk.stable_chunk_id as "chunkId",
      chunk.passage,
      chunk.section,
      case
        when p_query_embedding is null or chunk.embedding is null then 0::double precision
        else greatest(0, 1 - (chunk.embedding <=> p_query_embedding))::double precision
      end as semantic_score,
      greatest(
        extensions.similarity(lower(p_query), lower(chunk.passage)),
        extensions.similarity(lower(p_query), lower(coalesce(chunk.section, '')))
      )::double precision as lexical_score,
      case
        when p_query ~ '(案例|示例|例子|怎么教|教学活动|活动设计)'
          and chunk.section like '%附录%' then 0.12
        when chunk.section like '%课程内容%【内容要求】%' then 0.09
        when chunk.section like '%课程内容%【学业要求】%' then 0.08
        when chunk.section like '%课程内容%' then 0.05
        when chunk.section like '%教学提示%' then 0.055
        when chunk.section like '%课程目标%' then 0.04
        when chunk.section like '%学业质量%' then 0.04
        when chunk.section like '%附录%' then -0.01
        else 0
      end::double precision as section_score
    from public.curriculum_standard_documents document
    join public.curriculum_standard_releases release on release.id = document.release_id
    join public.knowledge_sources source on source.id = document.knowledge_source_id
    join public.knowledge_chunks chunk on chunk.source_id = source.id
    where release.status = 'published'
      and source.status = 'ready'
      and (document.subject = p_subject or document.document_kind = 'curriculum_plan')
      and (p_stage is null or p_stage = '' or p_stage = any(document.stage_scope))
      and (p_grade is null or p_grade = '' or cardinality(document.grade_scope) = 0 or p_grade = any(document.grade_scope))
  )
  select
    candidates.id,
    candidates.title,
    candidates.url,
    candidates.kind,
    candidates.page,
    candidates."chunkId",
    candidates.passage,
    (candidates.semantic_score + candidates.lexical_score * 0.12 + candidates.section_score)::double precision as score,
    candidates.section
  from candidates
  order by score desc, candidates."chunkId"
  limit least(8, greatest(1, p_limit));
$$;

revoke all on function public.search_curriculum_standards(text,vector,text,text,text,integer)
from public, anon, authenticated;
grant execute on function public.search_curriculum_standards(text,vector,text,text,text,integer)
to service_role;

