-- Chunk scope is primarily a hard safety/precision filter. Keep the matching
-- scope bonus small so universal clauses (for example core competencies and
-- the shared curriculum plan) can still outrank unrelated grade-specific text.
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
  with request_scope as (
    select
      case trim(coalesce(p_grade, ''))
        when '一年级' then 1 when '二年级' then 2 when '三年级' then 3
        when '四年级' then 4 when '五年级' then 5 when '六年级' then 6
        when '七年级' then 7 when '八年级' then 8 when '九年级' then 9
        else nullif(substring(coalesce(p_grade, '') from '([1-9])'), '')::integer
      end as grade_number
  ), scoped_request as (
    select
      grade_number,
      case
        when p_subject = '语文' and grade_number between 1 and 2 then '第一学段'
        when p_subject = '语文' and grade_number between 3 and 4 then '第二学段'
        when p_subject = '语文' and grade_number between 5 and 6 then '第三学段'
        when p_subject = '语文' and grade_number between 7 and 9 then '第四学段'
        else null
      end as expected_stage
    from request_scope
  ), candidates as (
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
      end::double precision as section_score,
      (
        case
          when scope.grade_number is not null
            and chunk.curriculum_grade_range @> scope.grade_number then 0.02
          else 0
        end
        + case
          when scope.expected_stage is not null
            and chunk.curriculum_stage = scope.expected_stage then 0.01
          else 0
        end
      )::double precision as scope_score,
      case
        when p_query ~ '(修辞|比喻|拟人|排比|夸张)'
          and chunk.passage ~ '(修辞|比喻|拟人|排比|夸张)' then 0.18
        when p_query ~ '(阅读|鉴赏|文学|语言|词句)'
          and chunk.curriculum_domain = '阅读与鉴赏' then 0.08
        when p_query ~ '(朗读|诵读)'
          and chunk.passage ~ '(朗读|诵读)' then 0.08
        else 0
      end::double precision as intent_score
    from public.curriculum_standard_documents document
    join public.curriculum_standard_releases release on release.id = document.release_id
    join public.knowledge_sources source on source.id = document.knowledge_source_id
    join public.knowledge_chunks chunk on chunk.source_id = source.id
    cross join scoped_request scope
    where release.status = 'published'
      and source.status = 'ready'
      and (document.subject = p_subject or document.document_kind = 'curriculum_plan')
      and (p_stage is null or p_stage = '' or p_stage = any(document.stage_scope))
      and (p_grade is null or p_grade = '' or cardinality(document.grade_scope) = 0 or p_grade = any(document.grade_scope))
      and (
        scope.grade_number is null
        or chunk.curriculum_grade_range is null
        or chunk.curriculum_grade_range @> scope.grade_number
      )
      and (
        scope.expected_stage is null
        or chunk.curriculum_stage is null
        or chunk.curriculum_stage = scope.expected_stage
      )
  )
  select
    candidates.id,
    candidates.title,
    candidates.url,
    candidates.kind,
    candidates.page,
    candidates."chunkId",
    candidates.passage,
    (
      candidates.semantic_score
      + candidates.lexical_score * 0.12
      + candidates.section_score
      + candidates.scope_score
      + candidates.intent_score
    )::double precision as score,
    candidates.section
  from candidates
  order by score desc, candidates."chunkId"
  limit least(8, greatest(1, p_limit));
$$;

revoke all on function public.search_curriculum_standards(text,vector,text,text,text,integer)
from public, anon, authenticated;
grant execute on function public.search_curriculum_standards(text,vector,text,text,text,integer)
to service_role;
