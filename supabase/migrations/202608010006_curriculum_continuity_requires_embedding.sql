create or replace function public.read_curriculum_knowledge_continuity(
  p_textbook_id text,
  p_current_node_id text,
  p_entity_id uuid,
  p_limit integer default 12
)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  with selected_release as (
    select release.id, min(mapping.sequence_no) as current_sequence
    from public.curriculum_semantic_releases release
    join public.curriculum_node_semantics mapping on mapping.release_id = release.id
    where release.status = 'published'
      and mapping.review_state = 'approved'
      and mapping.textbook_id = p_textbook_id
      and mapping.node_id = p_current_node_id
    group by release.id, release.published_at
    order by release.published_at desc
    limit 1
  ), target as (
    select revision.release_id, revision.semantic_entity_id,
      revision.embedding, revision.search_text
    from selected_release release
    join public.curriculum_semantic_entity_revisions revision on revision.release_id = release.id
    where revision.semantic_entity_id = p_entity_id
      and revision.review_state = 'approved'
  ), ranked as (
    select target.semantic_entity_id, 1::double precision as score,
      'exact'::text as retrieval_method
    from target
    where exists (
      select 1 from public.curriculum_node_semantics occurrence
      where occurrence.release_id = target.release_id
        and occurrence.textbook_id = p_textbook_id
        and occurrence.semantic_entity_id = target.semantic_entity_id
        and occurrence.review_state = 'approved'
        and occurrence.node_id <> p_current_node_id
    )
    union all
    select revision.semantic_entity_id,
      greatest(0::double precision, 1 - (revision.embedding <=> target.embedding)) as score,
      'embedding'::text as retrieval_method
    from target
    join public.curriculum_semantic_entity_revisions revision
      on revision.release_id = target.release_id
    join public.curriculum_semantic_entities entity on entity.id = revision.semantic_entity_id
    where target.embedding is not null
      and revision.embedding is not null
      and revision.review_state = 'approved'
      and entity.kind = 'knowledge_point'
      and revision.semantic_entity_id <> target.semantic_entity_id
      and exists (
        select 1 from public.curriculum_node_semantics occurrence
        where occurrence.release_id = target.release_id
          and occurrence.textbook_id = p_textbook_id
          and occurrence.semantic_entity_id = revision.semantic_entity_id
          and occurrence.review_state = 'approved'
          and occurrence.node_id <> p_current_node_id
      )
    order by score desc, semantic_entity_id
    limit least(30, greatest(1, p_limit))
  )
  select case
    when not exists (select 1 from target) then jsonb_build_object(
      'status', 'unavailable', 'currentSequenceNo', null, 'candidates', '[]'::jsonb
    )
    when (select embedding is null from target) and not exists (select 1 from ranked) then
      jsonb_build_object(
        'status', 'semantic_search_unavailable',
        'currentSequenceNo', (select current_sequence from selected_release),
        'target', public.curriculum_semantic_entity_json((select release_id from target), p_entity_id),
        'candidates', '[]'::jsonb
      )
    else jsonb_build_object(
      'status', 'available',
      'currentSequenceNo', (select current_sequence from selected_release),
      'target', public.curriculum_semantic_entity_json((select release_id from target), p_entity_id),
      'candidates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'point', public.curriculum_semantic_entity_json((select release_id from target), ranked.semantic_entity_id),
          'score', ranked.score,
          'retrievalMethod', ranked.retrieval_method,
          'occurrences', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'mappingId', mapping.id,
              'nodeId', node.node_id,
              'nodeTitle', node.title,
              'pageNumber', node.page_number,
              'sequenceNo', mapping.sequence_no,
              'printedPages', mapping.printed_pages,
              'recommendedPeriod', mapping.recommended_period,
              'position', case
                when mapping.sequence_no < (select current_sequence from selected_release) then 'before'
                when mapping.sequence_no > (select current_sequence from selected_release) then 'after'
                else 'current'
              end
            ) order by abs(mapping.sequence_no - (select current_sequence from selected_release)), mapping.sequence_no), '[]'::jsonb)
            from public.curriculum_node_semantics mapping
            join public.curriculum_nodes node
              on node.textbook_id = mapping.textbook_id and node.node_id = mapping.node_id
            where mapping.release_id = (select release_id from target)
              and mapping.textbook_id = p_textbook_id
              and mapping.semantic_entity_id = ranked.semantic_entity_id
              and mapping.review_state = 'approved'
              and mapping.node_id <> p_current_node_id
              and node.retired_at is null
          )
        ) order by ranked.score desc)
        from ranked
      ), '[]'::jsonb)
    )
  end;
$$;

revoke all on function public.read_curriculum_knowledge_continuity(text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.read_curriculum_knowledge_continuity(text, text, uuid, integer)
  to service_role;
