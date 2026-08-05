-- Deterministic, reviewable teaching-continuity candidates for a pinned
-- semester framework. This deliberately does not depend on embeddings.

create table public.framework_continuity_candidates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  framework_id uuid not null,
  derived_from_framework_version integer not null check (derived_from_framework_version >= 0),
  target_unit_id uuid not null,
  direction text not null check (direction in ('review', 'prepare')),
  semantic_release_id uuid not null,
  current_entity_id uuid not null,
  current_point_name text not null,
  related_entity_id uuid not null,
  related_point_name text not null,
  related_unit_id uuid not null,
  evidence_kind text not null
    check (evidence_kind in ('same_knowledge_point', 'approved_relation')),
  relation_id uuid,
  relation_type text check (relation_type in (
    'prerequisite', 'supports', 'develops_into', 'transfers_to'
  )),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  rationale text not null,
  evidence jsonb not null default '{}'::jsonb,
  fingerprint text not null,
  decision text not null default 'candidate'
    check (decision in ('candidate', 'accepted', 'dismissed')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, framework_id, fingerprint),
  foreign key (owner_id, framework_id, semantic_release_id)
    references public.semester_frameworks(owner_id, id, semantic_release_id)
    on delete cascade,
  foreign key (owner_id, framework_id, target_unit_id)
    references public.semester_units(owner_id, framework_id, id)
    on delete cascade,
  foreign key (owner_id, framework_id, related_unit_id)
    references public.semester_units(owner_id, framework_id, id)
    on delete cascade,
  foreign key (semantic_release_id, current_entity_id)
    references public.curriculum_semantic_entity_revisions(release_id, semantic_entity_id)
    on delete restrict,
  foreign key (semantic_release_id, related_entity_id)
    references public.curriculum_semantic_entity_revisions(release_id, semantic_entity_id)
    on delete restrict,
  foreign key (semantic_release_id, relation_id)
    references public.curriculum_semantic_relations(release_id, id)
    on delete restrict,
  check (
    (evidence_kind = 'same_knowledge_point'
      and current_entity_id = related_entity_id
      and relation_id is null
      and relation_type is null)
    or
    (evidence_kind = 'approved_relation'
      and relation_id is not null
      and relation_type is not null)
  ),
  check (jsonb_typeof(evidence) = 'object')
);

create index framework_continuity_target_idx
  on public.framework_continuity_candidates(
    owner_id, framework_id, target_unit_id, direction, confidence desc
  ) where active;
create index framework_continuity_related_idx
  on public.framework_continuity_candidates(
    owner_id, framework_id, related_unit_id
  ) where active;

alter table public.framework_continuity_candidates enable row level security;
revoke all on public.framework_continuity_candidates from public, anon, authenticated;
grant select, insert, update, delete on public.framework_continuity_candidates to service_role;

create or replace function public.refresh_semester_framework_continuity(
  p_owner_id uuid,
  p_framework_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  framework public.semester_frameworks%rowtype;
  result jsonb;
begin
  perform public.assert_service_scope(p_owner_id);

  select * into framework
  from public.semester_frameworks candidate
  where candidate.owner_id = p_owner_id and candidate.id = p_framework_id
  for update;
  if not found then raise exception 'semester_framework_not_found'; end if;

  update public.framework_continuity_candidates
  set active = false, updated_at = now()
  where owner_id = p_owner_id and framework_id = p_framework_id and active;

  if framework.semantic_release_id is null then
    return jsonb_build_object(
      'status', 'semantic_release_unavailable',
      'frameworkVersion', framework.version,
      'candidates', '[]'::jsonb
    );
  end if;

  with recursive unit_nodes as (
    select unit_record.id as unit_id,
      unit_record.sort_no as unit_sort_no,
      node.node_id,
      node.parent_id,
      node.level,
      node.sort_no as node_sort_no
    from public.semester_units unit_record
    join public.curriculum_node_revisions node
      on node.catalog_release_id = framework.catalog_release_id
      and node.textbook_id = framework.textbook_id
      and node.node_id = unit_record.curriculum_node_id
    where unit_record.owner_id = p_owner_id
      and unit_record.framework_id = p_framework_id

    union all

    select parent.unit_id,
      parent.unit_sort_no,
      child.node_id,
      child.parent_id,
      child.level,
      child.sort_no
    from unit_nodes parent
    join public.curriculum_node_revisions child
      on child.catalog_release_id = framework.catalog_release_id
      and child.textbook_id = framework.textbook_id
      and child.parent_id = parent.node_id
  ), unit_points as (
    select distinct on (unit_node.unit_id, mapping.semantic_entity_id)
      unit_node.unit_id,
      unit_node.unit_sort_no,
      unit_node.node_id,
      mapping.sequence_no,
      mapping.semantic_entity_id,
      revision.canonical_name as point_name,
      least(mapping.confidence, revision.confidence) as confidence
    from unit_nodes unit_node
    join public.curriculum_node_semantics mapping
      on mapping.release_id = framework.semantic_release_id
      and mapping.textbook_id = framework.textbook_id
      and mapping.node_id = unit_node.node_id
      and mapping.review_state = 'approved'
    join public.curriculum_semantic_entity_revisions revision
      on revision.release_id = mapping.release_id
      and revision.semantic_entity_id = mapping.semantic_entity_id
      and revision.review_state = 'approved'
    join public.curriculum_semantic_entities entity
      on entity.id = mapping.semantic_entity_id
    where entity.kind <> 'misconception'
    order by unit_node.unit_id, mapping.semantic_entity_id,
      mapping.priority, mapping.sequence_no nulls last,
      unit_node.level, unit_node.node_sort_no, unit_node.node_id
  ), same_point_candidates as (
    select current_point.unit_id as target_unit_id,
      case when related_point.unit_sort_no < current_point.unit_sort_no
        then 'review' else 'prepare' end as direction,
      current_point.semantic_entity_id as current_entity_id,
      current_point.point_name as current_point_name,
      related_point.semantic_entity_id as related_entity_id,
      related_point.point_name as related_point_name,
      related_point.unit_id as related_unit_id,
      'same_knowledge_point'::text as evidence_kind,
      null::uuid as relation_id,
      null::text as relation_type,
      least(current_point.confidence, related_point.confidence) as confidence,
      case when related_point.unit_sort_no < current_point.unit_sort_no
        then '同一已审核知识点“' || current_point.point_name
          || '”已在前序单元出现；是否复习仍需结合当前学情。'
        else '同一已审核知识点“' || current_point.point_name
          || '”会在后续单元再次出现；可在本单元设计必要铺垫。'
      end as rationale,
      jsonb_build_object(
        'currentNodeId', current_point.node_id,
        'currentSequenceNo', current_point.sequence_no,
        'relatedNodeId', related_point.node_id,
        'relatedSequenceNo', related_point.sequence_no
      ) as evidence
    from unit_points current_point
    join unit_points related_point
      on related_point.semantic_entity_id = current_point.semantic_entity_id
      and related_point.unit_id <> current_point.unit_id
  ), relation_pairs as (
    select relation.id as relation_id,
      relation.relation_type,
      relation.confidence as relation_confidence,
      relation.rationale as relation_rationale,
      from_point.*,
      to_point.unit_id as to_unit_id,
      to_point.unit_sort_no as to_unit_sort_no,
      to_point.node_id as to_node_id,
      to_point.sequence_no as to_sequence_no,
      to_point.semantic_entity_id as to_entity_id,
      to_point.point_name as to_point_name,
      to_point.confidence as to_confidence
    from public.curriculum_semantic_relations relation
    join unit_points from_point
      on from_point.semantic_entity_id = relation.from_entity_id
    join unit_points to_point
      on to_point.semantic_entity_id = relation.to_entity_id
    where relation.release_id = framework.semantic_release_id
      and relation.review_state = 'approved'
      and relation.relation_type in (
        'prerequisite', 'supports', 'develops_into', 'transfers_to'
      )
      and from_point.unit_sort_no < to_point.unit_sort_no
      and exists (
        select 1 from public.curriculum_semantic_relation_sources source_link
        where source_link.release_id = relation.release_id
          and source_link.relation_id = relation.id
      )
  ), relation_candidates as (
    select pair.to_unit_id as target_unit_id,
      'review'::text as direction,
      pair.to_entity_id as current_entity_id,
      pair.to_point_name as current_point_name,
      pair.semantic_entity_id as related_entity_id,
      pair.point_name as related_point_name,
      pair.unit_id as related_unit_id,
      'approved_relation'::text as evidence_kind,
      pair.relation_id,
      pair.relation_type,
      least(pair.confidence, pair.to_confidence, pair.relation_confidence) as confidence,
      '平台已审核“' || pair.point_name || '”到“' || pair.to_point_name
        || '”的' || pair.relation_type || '关系；前者是复习候选。' as rationale,
      jsonb_build_object(
        'fromNodeId', pair.node_id,
        'fromSequenceNo', pair.sequence_no,
        'toNodeId', pair.to_node_id,
        'toSequenceNo', pair.to_sequence_no,
        'relationRationale', pair.relation_rationale
      ) as evidence
    from relation_pairs pair

    union all

    select pair.unit_id as target_unit_id,
      'prepare'::text as direction,
      pair.semantic_entity_id as current_entity_id,
      pair.point_name as current_point_name,
      pair.to_entity_id as related_entity_id,
      pair.to_point_name as related_point_name,
      pair.to_unit_id as related_unit_id,
      'approved_relation'::text as evidence_kind,
      pair.relation_id,
      pair.relation_type,
      least(pair.confidence, pair.to_confidence, pair.relation_confidence) as confidence,
      '平台已审核“' || pair.point_name || '”到“' || pair.to_point_name
        || '”的' || pair.relation_type || '关系；后者是铺垫候选。' as rationale,
      jsonb_build_object(
        'fromNodeId', pair.node_id,
        'fromSequenceNo', pair.sequence_no,
        'toNodeId', pair.to_node_id,
        'toSequenceNo', pair.to_sequence_no,
        'relationRationale', pair.relation_rationale
      ) as evidence
    from relation_pairs pair
  ), candidates as (
    select * from same_point_candidates
    union all
    select * from relation_candidates
  ), prepared as (
    select candidate.*,
      encode(extensions.digest(jsonb_build_object(
        'targetUnitId', candidate.target_unit_id,
        'direction', candidate.direction,
        'currentEntityId', candidate.current_entity_id,
        'relatedEntityId', candidate.related_entity_id,
        'relatedUnitId', candidate.related_unit_id,
        'evidenceKind', candidate.evidence_kind,
        'relationId', candidate.relation_id
      )::text, 'sha256'), 'hex') as fingerprint
    from candidates candidate
  )
  insert into public.framework_continuity_candidates(
    owner_id, framework_id, derived_from_framework_version,
    target_unit_id, direction, semantic_release_id,
    current_entity_id, current_point_name, related_entity_id,
    related_point_name, related_unit_id, evidence_kind, relation_id,
    relation_type, confidence, rationale, evidence, fingerprint
  )
  select p_owner_id, p_framework_id, framework.version,
    prepared.target_unit_id, prepared.direction, framework.semantic_release_id,
    prepared.current_entity_id, prepared.current_point_name,
    prepared.related_entity_id, prepared.related_point_name,
    prepared.related_unit_id, prepared.evidence_kind, prepared.relation_id,
    prepared.relation_type, prepared.confidence, prepared.rationale,
    prepared.evidence, prepared.fingerprint
  from prepared
  on conflict (owner_id, framework_id, fingerprint) do update
  set derived_from_framework_version = excluded.derived_from_framework_version,
      current_point_name = excluded.current_point_name,
      related_point_name = excluded.related_point_name,
      confidence = excluded.confidence,
      rationale = excluded.rationale,
      evidence = excluded.evidence,
      active = true,
      updated_at = now();

  select jsonb_build_object(
    'status', 'available',
    'frameworkVersion', framework.version,
    'candidates', coalesce(jsonb_agg(to_jsonb(candidate)
      order by candidate.target_unit_id, candidate.direction,
        candidate.confidence desc, candidate.id), '[]'::jsonb)
  ) into result
  from public.framework_continuity_candidates candidate
  where candidate.owner_id = p_owner_id
    and candidate.framework_id = p_framework_id
    and candidate.active;

  return result;
end;
$$;

revoke all on function public.refresh_semester_framework_continuity(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_semester_framework_continuity(uuid, uuid)
  to service_role;
