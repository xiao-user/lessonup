-- Stable catalog identities and the platform curriculum semantic graph.
-- Catalog rows are retired instead of deleted so reviewed semantic references remain auditable.

alter table public.curriculum_textbooks
  add column if not exists catalog_generation_id text not null default 'legacy',
  add column if not exists retired_at timestamptz;

alter table public.curriculum_nodes
  add column if not exists catalog_generation_id text not null default 'legacy',
  add column if not exists retired_at timestamptz;

create index if not exists curriculum_textbooks_active_taxonomy_idx
  on public.curriculum_textbooks(stage, subject, edition, grade)
  where retired_at is null;
create index if not exists curriculum_nodes_active_parent_idx
  on public.curriculum_nodes(textbook_id, parent_id, sort_no)
  where retired_at is null;

create or replace function public.publish_curriculum_catalog(
  p_import_id uuid,
  p_generation_id text,
  p_expected_textbooks integer,
  p_expected_nodes integer,
  p_manifest jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actual_textbooks integer;
  actual_nodes integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  select count(*) into actual_textbooks
  from curriculum_textbooks_staging where import_id = p_import_id;
  select count(*) into actual_nodes
  from curriculum_nodes_staging where import_id = p_import_id;
  if actual_textbooks <> p_expected_textbooks or actual_nodes <> p_expected_nodes then
    raise exception 'curriculum_staging_count_mismatch';
  end if;
  if exists (
    select 1
    from curriculum_nodes_staging n
    left join curriculum_nodes_staging p
      on p.import_id = n.import_id
      and p.textbook_id = n.textbook_id
      and p.node_id = n.parent_id
    where n.import_id = p_import_id
      and n.parent_id is not null
      and p.node_id is null
  ) then
    raise exception 'curriculum_staging_orphan_node';
  end if;
  if exists (
    select 1
    from curriculum_textbooks_staging b
    left join (
      select textbook_id, count(*) as node_count
      from curriculum_nodes_staging
      where import_id = p_import_id
      group by textbook_id
    ) n on n.textbook_id = b.id
    where b.import_id = p_import_id
      and b.node_count <> coalesce(n.node_count, 0)
  ) then
    raise exception 'curriculum_staging_book_count_mismatch';
  end if;

  set constraints curriculum_nodes_parent_fk deferred;

  insert into curriculum_textbooks (
    id, title, stage, subject, edition, grade, volume, publisher_id,
    ebook_id, detail_url, tree_url, source_pdf_url, source_list_url,
    node_count, source_updated_at, updated_at, catalog_generation_id, retired_at
  )
  select id, title, stage, subject, edition, grade, volume, publisher_id,
    ebook_id, detail_url, tree_url, source_pdf_url, source_list_url,
    node_count, source_updated_at, updated_at, p_generation_id, null
  from curriculum_textbooks_staging
  where import_id = p_import_id
  on conflict (id) do update set
    title = excluded.title,
    stage = excluded.stage,
    subject = excluded.subject,
    edition = excluded.edition,
    grade = excluded.grade,
    volume = excluded.volume,
    publisher_id = excluded.publisher_id,
    ebook_id = excluded.ebook_id,
    detail_url = excluded.detail_url,
    tree_url = excluded.tree_url,
    source_pdf_url = excluded.source_pdf_url,
    source_list_url = excluded.source_list_url,
    node_count = excluded.node_count,
    source_updated_at = excluded.source_updated_at,
    updated_at = excluded.updated_at,
    catalog_generation_id = excluded.catalog_generation_id,
    retired_at = null;

  insert into curriculum_nodes (
    textbook_id, node_id, parent_id, level, sort_no, title, page_number,
    catalog_generation_id, retired_at
  )
  select textbook_id, node_id, parent_id, level, sort_no, title, page_number,
    p_generation_id, null
  from curriculum_nodes_staging
  where import_id = p_import_id
  on conflict (textbook_id, node_id) do update set
    parent_id = excluded.parent_id,
    level = excluded.level,
    sort_no = excluded.sort_no,
    title = excluded.title,
    page_number = excluded.page_number,
    catalog_generation_id = excluded.catalog_generation_id,
    retired_at = null;

  update curriculum_nodes node
  set retired_at = now()
  where node.retired_at is null
    and not exists (
      select 1 from curriculum_nodes_staging staged
      where staged.import_id = p_import_id
        and staged.textbook_id = node.textbook_id
        and staged.node_id = node.node_id
    );

  update curriculum_textbooks textbook
  set retired_at = now(), updated_at = now()
  where textbook.retired_at is null
    and not exists (
      select 1 from curriculum_textbooks_staging staged
      where staged.import_id = p_import_id and staged.id = textbook.id
    );

  insert into curriculum_catalog_state(singleton, generation_id, manifest, published_at)
  values (true, p_generation_id, p_manifest, now())
  on conflict (singleton) do update
  set generation_id = excluded.generation_id,
      manifest = excluded.manifest,
      published_at = excluded.published_at;

  delete from curriculum_textbooks_staging where import_id = p_import_id;
end
$$;

create or replace function public.search_curriculum_textbooks(
  p_stage text default null,
  p_subject text default null,
  p_edition text default null,
  p_grade text default null,
  p_query text default null,
  p_limit integer default 20
)
returns setof public.curriculum_textbooks
language sql
stable
security definer
set search_path = public
as $$
  select textbook.*
  from public.curriculum_textbooks textbook
  where textbook.retired_at is null
    and (p_stage is null or textbook.stage = p_stage)
    and (p_subject is null or textbook.subject = p_subject)
    and (p_edition is null or textbook.edition = p_edition)
    and (p_grade is null or textbook.grade = p_grade)
    and (
      p_query is null
      or concat_ws(' ', textbook.title, textbook.volume, textbook.edition, textbook.subject)
        ilike '%' || p_query || '%'
    )
  order by textbook.stage, textbook.subject, textbook.edition, textbook.title
  limit least(200, greatest(1, p_limit));
$$;

create table public.curriculum_semantic_releases (
  id uuid primary key default gen_random_uuid(),
  scope_key text not null,
  catalog_generation_id text not null,
  subject text not null,
  stage text not null default '',
  edition text not null default '',
  grade text not null default '',
  volume text not null default '',
  schema_version integer not null default 1 check (schema_version > 0),
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  source_manifest jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  retired_at timestamptz
);

create unique index curriculum_semantic_one_published_scope_idx
  on public.curriculum_semantic_releases(scope_key)
  where status = 'published';

create table public.curriculum_semantic_entities (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  stage text not null default '',
  kind text not null check (kind in (
    'knowledge', 'method', 'strategy', 'capability', 'learning_outcome', 'misconception'
  )),
  canonical_key text not null,
  created_at timestamptz not null default now(),
  unique(subject, stage, kind, canonical_key)
);

create table public.curriculum_semantic_entity_revisions (
  release_id uuid not null references public.curriculum_semantic_releases(id) on delete cascade,
  semantic_entity_id uuid not null references public.curriculum_semantic_entities(id) on delete restrict,
  canonical_name text not null,
  definition text not null,
  payload jsonb not null default '{}'::jsonb,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  review_state text not null default 'draft' check (review_state in ('draft', 'approved', 'rejected')),
  primary key(release_id, semantic_entity_id)
);

create table public.curriculum_semantic_relations (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.curriculum_semantic_releases(id) on delete cascade,
  from_entity_id uuid not null references public.curriculum_semantic_entities(id) on delete restrict,
  to_entity_id uuid not null references public.curriculum_semantic_entities(id) on delete restrict,
  relation_type text not null check (relation_type in (
    'part_of', 'prerequisite', 'supports', 'develops_into', 'contrasts_with',
    'often_confused_with', 'transfers_to'
  )),
  grade_from text,
  grade_to text,
  strength numeric(4,3) not null default 1 check (strength between 0 and 1),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  rationale text not null,
  review_state text not null default 'draft' check (review_state in ('draft', 'approved', 'rejected')),
  check (from_entity_id <> to_entity_id),
  unique(release_id, id)
);

create table public.curriculum_node_semantics (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.curriculum_semantic_releases(id) on delete cascade,
  textbook_id text not null,
  node_id text not null,
  semantic_entity_id uuid not null references public.curriculum_semantic_entities(id) on delete restrict,
  instructional_role text not null check (instructional_role in (
    'introduces', 'develops', 'reinforces', 'applies', 'transfers', 'assesses', 'background'
  )),
  expected_depth integer not null default 1 check (expected_depth between 1 and 5),
  priority integer not null default 1 check (priority between 1 and 10),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  rationale text not null,
  review_state text not null default 'draft' check (review_state in ('draft', 'approved', 'rejected')),
  foreign key(textbook_id, node_id)
    references public.curriculum_nodes(textbook_id, node_id) on delete restrict,
  unique(release_id, textbook_id, node_id, semantic_entity_id, instructional_role),
  unique(release_id, id)
);

create index curriculum_node_semantics_node_idx
  on public.curriculum_node_semantics(textbook_id, node_id, release_id);
create index curriculum_semantic_relations_from_idx
  on public.curriculum_semantic_relations(from_entity_id, relation_type, release_id);
create index curriculum_semantic_relations_to_idx
  on public.curriculum_semantic_relations(to_entity_id, relation_type, release_id);

create table public.curriculum_semantic_sources (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.curriculum_semantic_releases(id) on delete cascade,
  source_ref_id text not null,
  title text not null,
  url text,
  source_kind text not null default 'public' check (source_kind = 'public'),
  authority text not null,
  locator text,
  created_at timestamptz not null default now(),
  unique(release_id, source_ref_id),
  unique(release_id, id)
);

create table public.curriculum_semantic_entity_sources (
  release_id uuid not null,
  semantic_entity_id uuid not null,
  source_id uuid not null,
  primary key(release_id, semantic_entity_id, source_id),
  foreign key(release_id, semantic_entity_id)
    references public.curriculum_semantic_entity_revisions(release_id, semantic_entity_id) on delete cascade,
  foreign key(release_id, source_id)
    references public.curriculum_semantic_sources(release_id, id) on delete cascade
);

create table public.curriculum_semantic_relation_sources (
  release_id uuid not null,
  relation_id uuid not null,
  source_id uuid not null,
  primary key(release_id, relation_id, source_id),
  foreign key(release_id, relation_id)
    references public.curriculum_semantic_relations(release_id, id) on delete cascade,
  foreign key(release_id, source_id)
    references public.curriculum_semantic_sources(release_id, id) on delete cascade
);

create table public.curriculum_node_semantic_sources (
  release_id uuid not null,
  node_semantic_id uuid not null,
  source_id uuid not null,
  primary key(release_id, node_semantic_id, source_id),
  foreign key(release_id, node_semantic_id)
    references public.curriculum_node_semantics(release_id, id) on delete cascade,
  foreign key(release_id, source_id)
    references public.curriculum_semantic_sources(release_id, id) on delete cascade
);

alter table public.curriculum_semantic_releases enable row level security;
alter table public.curriculum_semantic_entities enable row level security;
alter table public.curriculum_semantic_entity_revisions enable row level security;
alter table public.curriculum_semantic_relations enable row level security;
alter table public.curriculum_node_semantics enable row level security;
alter table public.curriculum_semantic_sources enable row level security;
alter table public.curriculum_semantic_entity_sources enable row level security;
alter table public.curriculum_semantic_relation_sources enable row level security;
alter table public.curriculum_node_semantic_sources enable row level security;

revoke all on public.curriculum_semantic_releases,
  public.curriculum_semantic_entities,
  public.curriculum_semantic_entity_revisions,
  public.curriculum_semantic_relations,
  public.curriculum_node_semantics,
  public.curriculum_semantic_sources,
  public.curriculum_semantic_entity_sources,
  public.curriculum_semantic_relation_sources,
  public.curriculum_node_semantic_sources
  from public, anon, authenticated;
grant select, insert, update, delete on public.curriculum_semantic_releases,
  public.curriculum_semantic_entities,
  public.curriculum_semantic_entity_revisions,
  public.curriculum_semantic_relations,
  public.curriculum_node_semantics,
  public.curriculum_semantic_sources,
  public.curriculum_semantic_entity_sources,
  public.curriculum_semantic_relation_sources,
  public.curriculum_node_semantic_sources
  to service_role;

create or replace function public.publish_curriculum_semantic_release(p_release_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  release_record curriculum_semantic_releases%rowtype;
  current_generation text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  select * into release_record
  from curriculum_semantic_releases
  where id = p_release_id for update;
  if not found then raise exception 'curriculum_semantic_release_not_found'; end if;
  if release_record.status <> 'draft' then raise exception 'curriculum_semantic_release_not_draft'; end if;

  select generation_id into current_generation
  from curriculum_catalog_state where singleton = true;
  if current_generation is null or release_record.catalog_generation_id <> current_generation then
    raise exception 'curriculum_semantic_catalog_generation_mismatch';
  end if;
  if not exists (
    select 1 from curriculum_semantic_entity_revisions where release_id = p_release_id
  ) then
    raise exception 'curriculum_semantic_release_empty';
  end if;
  if exists (
    select 1 from curriculum_semantic_entity_revisions revision
    where revision.release_id = p_release_id
      and (
        revision.review_state <> 'approved'
        or not exists (
          select 1 from curriculum_semantic_entity_sources source_link
          where source_link.release_id = revision.release_id
            and source_link.semantic_entity_id = revision.semantic_entity_id
        )
      )
  ) then
    raise exception 'curriculum_semantic_entity_unpublishable';
  end if;
  if exists (
    select 1 from curriculum_semantic_relations relation
    where relation.release_id = p_release_id
      and (
        relation.review_state <> 'approved'
        or not exists (
          select 1 from curriculum_semantic_entity_revisions revision
          where revision.release_id = relation.release_id
            and revision.semantic_entity_id = relation.from_entity_id
        )
        or not exists (
          select 1 from curriculum_semantic_entity_revisions revision
          where revision.release_id = relation.release_id
            and revision.semantic_entity_id = relation.to_entity_id
        )
        or not exists (
          select 1 from curriculum_semantic_relation_sources source_link
          where source_link.release_id = relation.release_id
            and source_link.relation_id = relation.id
        )
      )
  ) then
    raise exception 'curriculum_semantic_relation_unpublishable';
  end if;
  if exists (
    select 1
    from curriculum_node_semantics mapping
    left join curriculum_nodes node
      on node.textbook_id = mapping.textbook_id and node.node_id = mapping.node_id
    left join curriculum_textbooks textbook on textbook.id = mapping.textbook_id
    where mapping.release_id = p_release_id
      and (
        mapping.review_state <> 'approved'
        or node.node_id is null or node.retired_at is not null or textbook.retired_at is not null
        or not exists (
          select 1 from curriculum_semantic_entity_revisions revision
          where revision.release_id = mapping.release_id
            and revision.semantic_entity_id = mapping.semantic_entity_id
        )
        or not exists (
          select 1 from curriculum_node_semantic_sources source_link
          where source_link.release_id = mapping.release_id
            and source_link.node_semantic_id = mapping.id
        )
      )
  ) then
    raise exception 'curriculum_node_semantic_unpublishable';
  end if;
  if exists (
    with recursive included_relations as (
      select relation.from_entity_id, relation.to_entity_id
      from curriculum_semantic_relations relation
      join curriculum_semantic_releases release on release.id = relation.release_id
      where relation.relation_type in ('prerequisite', 'develops_into')
        and relation.review_state = 'approved'
        and (
          relation.release_id = p_release_id
          or (release.status = 'published' and release.scope_key <> release_record.scope_key)
        )
    ), reach(origin_id, current_id) as (
      select edge.from_entity_id, edge.to_entity_id
      from included_relations edge
      union
      select reach.origin_id, edge.to_entity_id
      from reach
      join included_relations edge on edge.from_entity_id = reach.current_id
    )
    select 1 from reach where origin_id = current_id limit 1
  ) then
    raise exception 'curriculum_semantic_progression_cycle';
  end if;

  update curriculum_semantic_releases
  set status = 'retired', retired_at = now()
  where scope_key = release_record.scope_key and status = 'published';
  update curriculum_semantic_releases
  set status = 'published', published_at = now(), retired_at = null
  where id = p_release_id;
end
$$;

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

create or replace function public.read_curriculum_node_semantics(
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
  selected_release curriculum_semantic_releases%rowtype;
begin
  select release.* into selected_release
  from curriculum_semantic_releases release
  join curriculum_node_semantics mapping on mapping.release_id = release.id
  join curriculum_nodes node
    on node.textbook_id = mapping.textbook_id and node.node_id = mapping.node_id
  join curriculum_textbooks textbook on textbook.id = mapping.textbook_id
  where release.status = 'published'
    and mapping.review_state = 'approved'
    and mapping.textbook_id = p_textbook_id and mapping.node_id = p_node_id
    and node.retired_at is null and textbook.retired_at is null
  order by release.published_at desc
  limit 1;

  if selected_release.id is null then
    return jsonb_build_object('release', null, 'mappings', '[]'::jsonb);
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
    'mappings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mapping.id,
        'instructionalRole', mapping.instructional_role,
        'expectedDepth', mapping.expected_depth,
        'priority', mapping.priority,
        'confidence', mapping.confidence::double precision,
        'rationale', mapping.rationale,
        'entity', curriculum_semantic_entity_json(mapping.release_id, mapping.semantic_entity_id),
        'sources', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', source.source_ref_id,
            'title', source.title,
            'url', source.url,
            'kind', source.source_kind,
            'authority', source.authority,
            'locator', source.locator
          ) order by source.title)
          from curriculum_node_semantic_sources source_link
          join curriculum_semantic_sources source
            on source.release_id = source_link.release_id and source.id = source_link.source_id
          where source_link.release_id = mapping.release_id
            and source_link.node_semantic_id = mapping.id
        ), '[]'::jsonb)
      ) order by mapping.priority, mapping.instructional_role)
      from curriculum_node_semantics mapping
      where mapping.release_id = selected_release.id
        and mapping.textbook_id = p_textbook_id and mapping.node_id = p_node_id
        and mapping.review_state = 'approved'
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.get_curriculum_semantic_entity(p_entity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select curriculum_semantic_entity_json(revision.release_id, revision.semantic_entity_id)
  from curriculum_semantic_entity_revisions revision
  join curriculum_semantic_releases release on release.id = revision.release_id
  where revision.semantic_entity_id = p_entity_id
    and revision.review_state = 'approved' and release.status = 'published'
  order by release.published_at desc
  limit 1;
$$;

create or replace function public.trace_curriculum_semantic_path(
  p_entity_id uuid,
  p_direction text default 'backward',
  p_relation_types text[] default array['prerequisite', 'develops_into', 'supports']::text[],
  p_max_depth integer default 3
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if p_direction not in ('backward', 'forward') then
    raise exception 'curriculum_semantic_direction_invalid';
  end if;

  with recursive edges as (
    select relation.*,
      case when p_direction = 'forward' then relation.from_entity_id else relation.to_entity_id end as current_entity_id,
      case when p_direction = 'forward' then relation.to_entity_id else relation.from_entity_id end as next_entity_id
    from curriculum_semantic_relations relation
    join curriculum_semantic_releases release on release.id = relation.release_id
    where release.status = 'published'
      and relation.review_state = 'approved'
      and relation.relation_type = any(p_relation_types)
  ), walk as (
    select edge.*, 1 as depth, array[p_entity_id, edge.next_entity_id] as visited
    from edges edge where edge.current_entity_id = p_entity_id
    union all
    select edge.*, walk.depth + 1, walk.visited || edge.next_entity_id
    from walk
    join edges edge on edge.current_entity_id = walk.next_entity_id
    where walk.depth < least(6, greatest(1, p_max_depth))
      and not edge.next_entity_id = any(walk.visited)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'relationId', walk.id,
    'relationType', walk.relation_type,
    'depth', walk.depth,
    'strength', walk.strength::double precision,
    'confidence', walk.confidence::double precision,
    'rationale', walk.rationale,
    'fromEntity', curriculum_semantic_entity_json(walk.release_id, walk.from_entity_id),
    'toEntity', curriculum_semantic_entity_json(walk.release_id, walk.to_entity_id),
    'reachedEntity', curriculum_semantic_entity_json(walk.release_id, walk.next_entity_id),
    'locations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'textbook', jsonb_build_object(
          'id', textbook.id, 'title', textbook.title, 'stage', textbook.stage,
          'subject', textbook.subject, 'edition', textbook.edition, 'grade', textbook.grade,
          'volume', textbook.volume, 'publisherId', textbook.publisher_id,
          'ebookId', textbook.ebook_id, 'detailUrl', textbook.detail_url,
          'treeUrl', textbook.tree_url, 'sourcePdfUrl', textbook.source_pdf_url,
          'sourceListUrl', textbook.source_list_url, 'nodeCount', textbook.node_count,
          'sourceUpdatedAt', textbook.source_updated_at
        ),
        'node', jsonb_build_object(
          'textbookId', node.textbook_id, 'nodeId', node.node_id,
          'parentId', node.parent_id, 'level', node.level, 'sortNo', node.sort_no,
          'title', node.title, 'pageNumber', node.page_number
        ),
        'instructionalRole', mapping.instructional_role,
        'expectedDepth', mapping.expected_depth
      ) order by textbook.grade, textbook.title, node.level, node.sort_no)
      from curriculum_node_semantics mapping
      join curriculum_semantic_releases release on release.id = mapping.release_id and release.status = 'published'
      join curriculum_nodes node
        on node.textbook_id = mapping.textbook_id and node.node_id = mapping.node_id
      join curriculum_textbooks textbook on textbook.id = mapping.textbook_id
      where mapping.semantic_entity_id = walk.next_entity_id
        and mapping.review_state = 'approved'
        and node.retired_at is null and textbook.retired_at is null
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', source.source_ref_id,
        'title', source.title,
        'url', source.url,
        'kind', source.source_kind,
        'authority', source.authority,
        'locator', source.locator
      ) order by source.title)
      from curriculum_semantic_relation_sources source_link
      join curriculum_semantic_sources source
        on source.release_id = source_link.release_id and source.id = source_link.source_id
      where source_link.release_id = walk.release_id and source_link.relation_id = walk.id
    ), '[]'::jsonb)
  ) order by walk.depth, walk.relation_type), '[]'::jsonb)
  into result
  from walk;

  return result;
end
$$;

alter table public.agent_run_evidence
  drop constraint if exists agent_run_evidence_kind_check;
alter table public.agent_run_evidence
  add constraint agent_run_evidence_kind_check check (
    kind in (
      'knowledge_search', 'knowledge_passage', 'attachment_read',
      'source_metadata', 'web_search', 'web_open',
      'curriculum_textbook', 'curriculum_outline', 'curriculum_semantics'
    )
  );

revoke all on function public.publish_curriculum_semantic_release(uuid),
  public.curriculum_semantic_entity_json(uuid, uuid),
  public.read_curriculum_node_semantics(text, text),
  public.get_curriculum_semantic_entity(uuid),
  public.trace_curriculum_semantic_path(uuid, text, text[], integer)
  from public, anon, authenticated;
grant execute on function public.publish_curriculum_semantic_release(uuid),
  public.curriculum_semantic_entity_json(uuid, uuid),
  public.read_curriculum_node_semantics(text, text),
  public.get_curriculum_semantic_entity(uuid),
  public.trace_curriculum_semantic_path(uuid, text, text[], integer)
  to service_role;
