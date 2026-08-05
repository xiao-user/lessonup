create extension if not exists pg_trgm with schema extensions;

alter table public.curriculum_semantic_entities
  drop constraint if exists curriculum_semantic_entities_kind_check;
alter table public.curriculum_semantic_entities
  add constraint curriculum_semantic_entities_kind_check check (kind in (
    'knowledge_point', 'knowledge', 'method', 'strategy', 'capability',
    'learning_outcome', 'misconception'
  ));

alter table public.curriculum_semantic_entity_revisions
  add column if not exists external_id text,
  add column if not exists search_text text not null default '',
  add column if not exists embedding vector(1024),
  add column if not exists embedding_model text;

create unique index if not exists curriculum_semantic_revision_external_id_idx
  on public.curriculum_semantic_entity_revisions(release_id, external_id)
  where external_id is not null;
create index if not exists curriculum_semantic_revision_search_trgm_idx
  on public.curriculum_semantic_entity_revisions
  using gin (search_text extensions.gin_trgm_ops);
create index if not exists curriculum_semantic_revision_embedding_idx
  on public.curriculum_semantic_entity_revisions
  using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

alter table public.curriculum_node_semantics
  drop constraint if exists curriculum_node_semantics_instructional_role_check;
alter table public.curriculum_node_semantics
  add constraint curriculum_node_semantics_instructional_role_check check (instructional_role in (
    'occurs_in', 'introduces', 'develops', 'reinforces', 'applies',
    'transfers', 'assesses', 'background'
  ));
alter table public.curriculum_node_semantics
  drop constraint if exists curriculum_node_semantics_expected_depth_check;
alter table public.curriculum_node_semantics
  add constraint curriculum_node_semantics_expected_depth_check check (expected_depth between 0 and 5);
alter table public.curriculum_node_semantics
  add column if not exists sequence_no integer check (sequence_no is null or sequence_no > 0),
  add column if not exists printed_pages text,
  add column if not exists recommended_period integer check (
    recommended_period is null or recommended_period > 0
  ),
  add column if not exists payload jsonb not null default '{}'::jsonb;

create index if not exists curriculum_node_semantics_sequence_idx
  on public.curriculum_node_semantics(release_id, textbook_id, sequence_no, node_id);
create index if not exists curriculum_node_semantics_entity_occurrence_idx
  on public.curriculum_node_semantics(release_id, semantic_entity_id, textbook_id, sequence_no);

create table public.curriculum_period_recommendations (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.curriculum_semantic_releases(id) on delete cascade,
  textbook_id text not null,
  node_id text not null,
  period_no integer not null check (period_no > 0),
  sequence_no integer not null check (sequence_no > 0),
  title text not null,
  mapping_type text not null,
  is_official boolean not null default false,
  note text not null default '',
  review_state text not null default 'draft' check (review_state in ('draft', 'approved', 'rejected')),
  foreign key(textbook_id, node_id)
    references public.curriculum_nodes(textbook_id, node_id) on delete restrict,
  unique(release_id, textbook_id, node_id, period_no),
  unique(release_id, id)
);

create table public.curriculum_period_recommendation_points (
  release_id uuid not null,
  period_recommendation_id uuid not null,
  semantic_entity_id uuid not null,
  sort_no integer not null check (sort_no > 0),
  primary key(release_id, period_recommendation_id, semantic_entity_id),
  foreign key(release_id, period_recommendation_id)
    references public.curriculum_period_recommendations(release_id, id) on delete cascade,
  foreign key(release_id, semantic_entity_id)
    references public.curriculum_semantic_entity_revisions(release_id, semantic_entity_id) on delete cascade
);

create index curriculum_period_recommendations_node_idx
  on public.curriculum_period_recommendations(release_id, textbook_id, node_id, period_no);
create index curriculum_period_recommendation_points_entity_idx
  on public.curriculum_period_recommendation_points(release_id, semantic_entity_id);

alter table public.curriculum_period_recommendations enable row level security;
alter table public.curriculum_period_recommendation_points enable row level security;
revoke all on public.curriculum_period_recommendations,
  public.curriculum_period_recommendation_points
  from public, anon, authenticated;
grant select, insert, update, delete on public.curriculum_period_recommendations,
  public.curriculum_period_recommendation_points
  to service_role;

create or replace function public.curriculum_semantic_entity_json(
  p_release_id uuid,
  p_entity_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', entity.id,
    'externalId', revision.external_id,
    'kind', entity.kind,
    'canonicalName', revision.canonical_name,
    'definition', revision.definition,
    'payload', revision.payload,
    'confidence', revision.confidence::double precision,
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', source.source_ref_id,
        'title', source.title,
        'url', source.url,
        'kind', source.source_kind,
        'authority', source.authority,
        'locator', source.locator
      ) order by source.title)
      from curriculum_semantic_entity_sources source_link
      join curriculum_semantic_sources source
        on source.release_id = source_link.release_id and source.id = source_link.source_id
      where source_link.release_id = revision.release_id
        and source_link.semantic_entity_id = revision.semantic_entity_id
    ), '[]'::jsonb)
  )
  from curriculum_semantic_entity_revisions revision
  join curriculum_semantic_entities entity on entity.id = revision.semantic_entity_id
  where revision.release_id = p_release_id and revision.semantic_entity_id = p_entity_id;
$$;

create or replace function public.curriculum_knowledge_occurrences_json(
  p_release_id uuid,
  p_textbook_id text,
  p_entity_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'mappingId', mapping.id,
    'nodeId', node.node_id,
    'nodeTitle', node.title,
    'pageNumber', node.page_number,
    'sequenceNo', mapping.sequence_no,
    'printedPages', mapping.printed_pages,
    'recommendedPeriod', mapping.recommended_period,
    'payload', mapping.payload
  ) order by mapping.sequence_no, node.level, node.sort_no), '[]'::jsonb)
  from curriculum_node_semantics mapping
  join curriculum_nodes node
    on node.textbook_id = mapping.textbook_id and node.node_id = mapping.node_id
  where mapping.release_id = p_release_id
    and mapping.textbook_id = p_textbook_id
    and mapping.semantic_entity_id = p_entity_id
    and mapping.review_state = 'approved'
    and node.retired_at is null;
$$;

create or replace function public.read_curriculum_node_knowledge_points(
  p_textbook_id text,
  p_node_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  selected_release public.curriculum_semantic_releases%rowtype;
begin
  select release.* into selected_release
  from public.curriculum_semantic_releases release
  join public.curriculum_node_semantics mapping on mapping.release_id = release.id
  where release.status = 'published'
    and mapping.review_state = 'approved'
    and mapping.textbook_id = p_textbook_id
    and mapping.node_id = p_node_id
    and mapping.instructional_role = 'occurs_in'
  order by release.published_at desc
  limit 1;

  if selected_release.id is null then
    return jsonb_build_object('release', null, 'points', '[]'::jsonb, 'periodRecommendations', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'release', jsonb_build_object(
      'id', selected_release.id,
      'scopeKey', selected_release.scope_key,
      'catalogGenerationId', selected_release.catalog_generation_id,
      'subject', selected_release.subject,
      'stage', selected_release.stage,
      'edition', selected_release.edition,
      'grade', selected_release.grade,
      'volume', selected_release.volume,
      'schemaVersion', selected_release.schema_version,
      'publishedAt', selected_release.published_at
    ),
    'points', coalesce((
      select jsonb_agg(jsonb_build_object(
        'mappingId', mapping.id,
        'sequenceNo', mapping.sequence_no,
        'printedPages', mapping.printed_pages,
        'recommendedPeriod', mapping.recommended_period,
        'mappingPayload', mapping.payload,
        'point', public.curriculum_semantic_entity_json(mapping.release_id, mapping.semantic_entity_id)
      ) order by mapping.priority, revision.external_id)
      from public.curriculum_node_semantics mapping
      join public.curriculum_semantic_entity_revisions revision
        on revision.release_id = mapping.release_id
        and revision.semantic_entity_id = mapping.semantic_entity_id
      where mapping.release_id = selected_release.id
        and mapping.textbook_id = p_textbook_id
        and mapping.node_id = p_node_id
        and mapping.instructional_role = 'occurs_in'
        and mapping.review_state = 'approved'
        and revision.review_state = 'approved'
    ), '[]'::jsonb),
    'periodRecommendations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', period.id,
        'periodNo', period.period_no,
        'title', period.title,
        'mappingType', period.mapping_type,
        'isOfficial', period.is_official,
        'note', period.note,
        'pointIds', coalesce((
          select jsonb_agg(link.semantic_entity_id order by link.sort_no)
          from public.curriculum_period_recommendation_points link
          where link.release_id = period.release_id
            and link.period_recommendation_id = period.id
        ), '[]'::jsonb)
      ) order by period.period_no)
      from public.curriculum_period_recommendations period
      where period.release_id = selected_release.id
        and period.textbook_id = p_textbook_id
        and period.node_id = p_node_id
        and period.review_state = 'approved'
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.search_curriculum_knowledge_points(
  p_textbook_id text,
  p_query text,
  p_query_embedding vector(1024) default null,
  p_limit integer default 12
)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  with selected_release as (
    select release.id
    from public.curriculum_semantic_releases release
    join public.curriculum_node_semantics mapping on mapping.release_id = release.id
    where release.status = 'published' and mapping.review_state = 'approved'
      and mapping.textbook_id = p_textbook_id
      and mapping.instructional_role = 'occurs_in'
    order by release.published_at desc
    limit 1
  ), ranked as (
    select distinct revision.semantic_entity_id,
      case
        when p_query_embedding is not null and revision.embedding is not null
          then greatest(0::double precision, 1 - (revision.embedding <=> p_query_embedding))
        when position(lower(p_query) in lower(revision.search_text)) > 0 then 1::double precision
        else similarity(lower(revision.search_text), lower(p_query))::double precision
      end as score,
      case when p_query_embedding is not null and revision.embedding is not null
        then 'embedding' else 'lexical' end as retrieval_method,
      release.id as release_id
    from selected_release release
    join public.curriculum_semantic_entity_revisions revision on revision.release_id = release.id
    join public.curriculum_semantic_entities entity on entity.id = revision.semantic_entity_id
    join public.curriculum_node_semantics mapping
      on mapping.release_id = revision.release_id
      and mapping.semantic_entity_id = revision.semantic_entity_id
      and mapping.textbook_id = p_textbook_id
    where entity.kind = 'knowledge_point'
      and revision.review_state = 'approved'
      and mapping.review_state = 'approved'
      and length(trim(p_query)) > 0
    order by score desc, revision.semantic_entity_id
    limit least(30, greatest(1, p_limit))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'point', public.curriculum_semantic_entity_json(ranked.release_id, ranked.semantic_entity_id),
    'score', ranked.score,
    'retrievalMethod', ranked.retrieval_method,
    'occurrences', public.curriculum_knowledge_occurrences_json(
      ranked.release_id, p_textbook_id, ranked.semantic_entity_id
    )
  ) order by ranked.score desc), '[]'::jsonb)
  from ranked;
$$;

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
    select revision.semantic_entity_id,
      case
        when target.embedding is not null and revision.embedding is not null
          then greatest(0::double precision, 1 - (revision.embedding <=> target.embedding))
        else similarity(lower(revision.search_text), lower(target.search_text))::double precision
      end as score,
      case when target.embedding is not null and revision.embedding is not null
        then 'embedding' else 'lexical' end as retrieval_method
    from target
    join public.curriculum_semantic_entity_revisions revision
      on revision.release_id = target.release_id
    join public.curriculum_semantic_entities entity on entity.id = revision.semantic_entity_id
    where revision.review_state = 'approved'
      and entity.kind = 'knowledge_point'
      and exists (
        select 1 from public.curriculum_node_semantics occurrence
        where occurrence.release_id = target.release_id
          and occurrence.textbook_id = p_textbook_id
          and occurrence.semantic_entity_id = revision.semantic_entity_id
          and occurrence.review_state = 'approved'
          and occurrence.node_id <> p_current_node_id
      )
    order by score desc, revision.semantic_entity_id
    limit least(30, greatest(1, p_limit))
  )
  select case when not exists (select 1 from target) then jsonb_build_object(
    'status', 'unavailable', 'currentSequenceNo', null, 'candidates', '[]'::jsonb
  ) else jsonb_build_object(
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
            and node.retired_at is null
        )
      ) order by ranked.score desc)
      from ranked
    ), '[]'::jsonb)
  ) end;
$$;

create or replace function public.import_curriculum_knowledge_release(
  p_payload jsonb,
  p_publish boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_release_id uuid := (p_payload #>> '{release,id}')::uuid;
  release_scope text := p_payload #>> '{release,scopeKey}';
  generation_id text := p_payload #>> '{release,catalogGenerationId}';
  current_generation text;
  item jsonb;
  source jsonb;
  period_item jsonb;
  entity_id uuid;
  source_id uuid;
  period_id uuid;
  existing_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required'; end if;
  if v_release_id is null or release_scope is null or generation_id is null then
    raise exception 'curriculum_knowledge_payload_invalid';
  end if;
  select state.generation_id into current_generation
  from public.curriculum_catalog_state state where state.singleton = true;
  if current_generation is distinct from generation_id then
    raise exception 'curriculum_semantic_catalog_generation_mismatch';
  end if;

  select status into existing_status from public.curriculum_semantic_releases where id = v_release_id;
  if existing_status = 'published' then
    return jsonb_build_object('releaseId', v_release_id, 'status', 'already_published');
  elsif existing_status is not null then
    delete from public.curriculum_semantic_releases where id = v_release_id;
  end if;

  insert into public.curriculum_semantic_releases(
    id, scope_key, catalog_generation_id, subject, stage, edition, grade, volume,
    schema_version, status, source_manifest
  ) values (
    v_release_id, release_scope, generation_id,
    p_payload #>> '{release,subject}', p_payload #>> '{release,stage}',
    p_payload #>> '{release,edition}', p_payload #>> '{release,grade}',
    p_payload #>> '{release,volume}', 2, 'draft',
    coalesce(p_payload #> '{release,sourceManifest}', '{}'::jsonb)
  );

  for item in select value from jsonb_array_elements(coalesce(p_payload->'entities', '[]'::jsonb)) loop
    entity_id := (item->>'id')::uuid;
    insert into public.curriculum_semantic_entities(id, subject, stage, kind, canonical_key)
    values (
      entity_id, p_payload #>> '{release,subject}', p_payload #>> '{release,stage}',
      'knowledge_point', item->>'canonicalKey'
    ) on conflict (id) do nothing;
    insert into public.curriculum_semantic_entity_revisions(
      release_id, semantic_entity_id, external_id, canonical_name, definition,
      payload, confidence, review_state, search_text, embedding, embedding_model
    ) values (
      v_release_id, entity_id, item->>'externalId', item->>'name', item->>'definition',
      coalesce(item->'payload', '{}'::jsonb), 1, case when p_publish then 'approved' else 'draft' end,
      concat_ws(' ', item->>'name', item->>'definition'),
      case when jsonb_typeof(item->'embedding') = 'array'
        then (item->'embedding')::text::vector(1024) else null end,
      item->>'embeddingModel'
    );
    source := item->'source';
    source_id := (source->>'id')::uuid;
    insert into public.curriculum_semantic_sources(
      id, release_id, source_ref_id, title, url, source_kind, authority, locator
    ) values (
      source_id, v_release_id, source->>'refId', source->>'title', source->>'url',
      'public', source->>'authority', source->>'locator'
    );
    insert into public.curriculum_semantic_entity_sources(release_id, semantic_entity_id, source_id)
    values (v_release_id, entity_id, source_id);
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_payload->'occurrences', '[]'::jsonb)) loop
    entity_id := (item->>'entityId')::uuid;
    source_id := (item->>'sourceId')::uuid;
    insert into public.curriculum_node_semantics(
      id, release_id, textbook_id, node_id, semantic_entity_id, instructional_role,
      expected_depth, priority, confidence, rationale, review_state,
      sequence_no, printed_pages, recommended_period, payload
    ) values (
      (item->>'id')::uuid, v_release_id, item->>'textbookId', item->>'nodeId', entity_id,
      'occurs_in', 0, (item->>'priority')::integer, 1,
      '样本知识点与教材目录节点的直接映射。',
      case when p_publish then 'approved' else 'draft' end,
      (item->>'sequenceNo')::integer, item->>'printedPages',
      nullif(item->>'recommendedPeriod', '')::integer, coalesce(item->'payload', '{}'::jsonb)
    );
    insert into public.curriculum_node_semantic_sources(release_id, node_semantic_id, source_id)
    values (v_release_id, (item->>'id')::uuid, source_id);
  end loop;

  for period_item in select value from jsonb_array_elements(coalesce(p_payload->'periodRecommendations', '[]'::jsonb)) loop
    period_id := (period_item->>'id')::uuid;
    insert into public.curriculum_period_recommendations(
      id, release_id, textbook_id, node_id, period_no, sequence_no, title,
      mapping_type, is_official, note, review_state
    ) values (
      period_id, v_release_id, period_item->>'textbookId', period_item->>'nodeId',
      (period_item->>'periodNo')::integer, (period_item->>'sequenceNo')::integer,
      period_item->>'title', period_item->>'mappingType',
      coalesce((period_item->>'isOfficial')::boolean, false),
      coalesce(period_item->>'note', ''), case when p_publish then 'approved' else 'draft' end
    );
    for item in select value from jsonb_array_elements(coalesce(period_item->'points', '[]'::jsonb)) loop
      insert into public.curriculum_period_recommendation_points(
        release_id, period_recommendation_id, semantic_entity_id, sort_no
      ) values (v_release_id, period_id, (item->>'entityId')::uuid, (item->>'sortNo')::integer);
    end loop;
  end loop;

  if not exists (
    select 1 from public.curriculum_semantic_entity_revisions revision
    where revision.release_id = v_release_id
  ) then raise exception 'curriculum_semantic_release_empty'; end if;

  if p_publish then perform public.publish_curriculum_semantic_release(v_release_id); end if;
  return jsonb_build_object(
    'releaseId', v_release_id,
    'status', case when p_publish then 'published' else 'draft' end,
    'entities', jsonb_array_length(coalesce(p_payload->'entities', '[]'::jsonb)),
    'occurrences', jsonb_array_length(coalesce(p_payload->'occurrences', '[]'::jsonb)),
    'periodRecommendations', jsonb_array_length(coalesce(p_payload->'periodRecommendations', '[]'::jsonb))
  );
end;
$$;

alter table public.agent_run_evidence
  drop constraint if exists agent_run_evidence_kind_check;
alter table public.agent_run_evidence
  add constraint agent_run_evidence_kind_check check (
    kind in (
      'knowledge_search', 'knowledge_passage', 'attachment_read',
      'source_metadata', 'web_search', 'web_open',
      'curriculum_textbook', 'curriculum_outline', 'curriculum_semantics',
      'curriculum_knowledge'
    )
  );

revoke all on function public.curriculum_knowledge_occurrences_json(uuid, text, uuid),
  public.read_curriculum_node_knowledge_points(text, text),
  public.search_curriculum_knowledge_points(text, text, vector, integer),
  public.read_curriculum_knowledge_continuity(text, text, uuid, integer),
  public.import_curriculum_knowledge_release(jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.curriculum_knowledge_occurrences_json(uuid, text, uuid),
  public.read_curriculum_node_knowledge_points(text, text),
  public.search_curriculum_knowledge_points(text, text, vector, integer),
  public.read_curriculum_knowledge_continuity(text, text, uuid, integer),
  public.import_curriculum_knowledge_release(jsonb, boolean)
  to service_role;
