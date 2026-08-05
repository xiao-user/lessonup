-- Independent, versioned lesson-design evidence. The A4 document remains the
-- execution artifact; this aggregate preserves why its decisions were made.

create table public.lesson_design_bases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  notebook_id text not null,
  lesson_file_id text not null,
  framework_id uuid,
  semester_unit_id uuid,
  lesson_blueprint_id uuid,
  catalog_release_id uuid,
  textbook_id text,
  curriculum_node_id text,
  semantic_release_id uuid,
  source_framework_version integer check (source_framework_version is null or source_framework_version >= 0),
  source_blueprint_version integer check (source_blueprint_version is null or source_blueprint_version >= 0),
  learner_context jsonb not null default '{}'::jsonb check (jsonb_typeof(learner_context) = 'object'),
  teacher_notes text not null default '',
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'stale')),
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, lesson_file_id),
  unique (owner_id, id, semantic_release_id, catalog_release_id, textbook_id),
  foreign key (owner_id, notebook_id, lesson_file_id)
    references public.lesson_files(owner_id, notebook_id, id) on delete cascade,
  foreign key (owner_id, notebook_id, framework_id)
    references public.semester_frameworks(owner_id, notebook_id, id) on delete restrict,
  foreign key (owner_id, framework_id, semester_unit_id)
    references public.semester_units(owner_id, framework_id, id) on delete restrict,
  foreign key (owner_id, framework_id, lesson_blueprint_id)
    references public.lesson_blueprints(owner_id, framework_id, id) on delete restrict,
  foreign key (catalog_release_id, textbook_id, curriculum_node_id)
    references public.curriculum_node_revisions(catalog_release_id, textbook_id, node_id)
    on delete restrict,
  foreign key (semantic_release_id, catalog_release_id)
    references public.curriculum_semantic_releases(id, catalog_release_id) on delete restrict,
  check (
    (framework_id is null and semester_unit_id is null and lesson_blueprint_id is null)
    or (framework_id is not null and semester_unit_id is not null)
  ),
  check (lesson_blueprint_id is null or semester_unit_id is not null),
  check (
    (catalog_release_id is null and textbook_id is null and curriculum_node_id is null and semantic_release_id is null)
    or (catalog_release_id is not null and textbook_id is not null and curriculum_node_id is not null)
  )
);

create table public.lesson_design_basis_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  basis_id uuid not null,
  semantic_release_id uuid,
  catalog_release_id uuid,
  textbook_id text,
  kind text not null check (kind in (
    'knowledge_point', 'review', 'prepare', 'student_difficulty', 'assessment_evidence'
  )),
  semantic_entity_id uuid,
  related_semantic_entity_id uuid,
  related_curriculum_node_id text,
  statement text not null check (char_length(trim(statement)) > 0),
  rationale text not null default '',
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  decision text not null default 'accepted' check (decision in ('accepted', 'dismissed')),
  teacher_confirmed boolean not null default true,
  origin text not null default 'teacher' check (origin in ('platform', 'teacher', 'agent', 'import')),
  sort_no integer not null check (sort_no > 0),
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, basis_id, id),
  unique (owner_id, basis_id, sort_no),
  foreign key (owner_id, basis_id, semantic_release_id, catalog_release_id, textbook_id)
    references public.lesson_design_bases(
      owner_id, id, semantic_release_id, catalog_release_id, textbook_id
    ) on delete cascade,
  foreign key (semantic_release_id, semantic_entity_id)
    references public.curriculum_semantic_entity_revisions(release_id, semantic_entity_id)
    on delete restrict,
  foreign key (semantic_release_id, related_semantic_entity_id)
    references public.curriculum_semantic_entity_revisions(release_id, semantic_entity_id)
    on delete restrict,
  foreign key (catalog_release_id, textbook_id, related_curriculum_node_id)
    references public.curriculum_node_revisions(catalog_release_id, textbook_id, node_id)
    on delete restrict,
  check (
    (kind = 'knowledge_point' and semantic_entity_id is not null
      and related_semantic_entity_id is null and related_curriculum_node_id is null)
    or (kind in ('review', 'prepare') and semantic_entity_id is not null
      and related_semantic_entity_id is not null and related_curriculum_node_id is not null)
    or (kind in ('student_difficulty', 'assessment_evidence')
      and related_semantic_entity_id is null and related_curriculum_node_id is null)
  )
);

create table public.lesson_design_basis_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  basis_id uuid not null,
  basis_version integer not null check (basis_version >= 0),
  snapshot jsonb not null,
  actor text not null check (actor in ('manual', 'agent', 'import')),
  run_id uuid,
  approval_id uuid references public.agent_approvals(id) on delete set null,
  idempotency_key text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  foreign key (owner_id, basis_id)
    references public.lesson_design_bases(owner_id, id) on delete cascade,
  unique (owner_id, basis_id, basis_version),
  unique (owner_id, idempotency_key)
);

create index lesson_design_bases_framework_idx
  on public.lesson_design_bases(owner_id, framework_id)
  where framework_id is not null;
create index lesson_design_bases_unit_idx
  on public.lesson_design_bases(owner_id, framework_id, semester_unit_id)
  where semester_unit_id is not null;
create index lesson_design_bases_blueprint_idx
  on public.lesson_design_bases(owner_id, framework_id, lesson_blueprint_id)
  where lesson_blueprint_id is not null;
create index lesson_design_basis_entries_basis_idx
  on public.lesson_design_basis_entries(owner_id, basis_id, sort_no);
create index lesson_design_basis_entries_semantic_idx
  on public.lesson_design_basis_entries(semantic_release_id, semantic_entity_id)
  where semantic_entity_id is not null;
create unique index lesson_design_basis_versions_approval_idx
  on public.lesson_design_basis_versions(owner_id, approval_id)
  where approval_id is not null;

alter table public.lesson_design_bases enable row level security;
alter table public.lesson_design_basis_entries enable row level security;
alter table public.lesson_design_basis_versions enable row level security;
revoke all on public.lesson_design_bases,
  public.lesson_design_basis_entries,
  public.lesson_design_basis_versions
  from public, anon, authenticated;
grant select, insert, update, delete on public.lesson_design_bases,
  public.lesson_design_basis_entries,
  public.lesson_design_basis_versions
  to service_role;

create or replace function public.lesson_design_basis_snapshot(
  p_owner_id uuid,
  p_lesson_file_id text
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'basis', to_jsonb(basis),
    'entries', coalesce((
      select jsonb_agg(
        to_jsonb(entry)
        || jsonb_build_object(
          'semantic_entity_name', semantic_revision.canonical_name,
          'related_semantic_entity_name', related_revision.canonical_name,
          'related_curriculum_node_title', related_node.title
        )
        order by entry.sort_no, entry.id
      )
      from public.lesson_design_basis_entries entry
      left join public.curriculum_semantic_entity_revisions semantic_revision
        on semantic_revision.release_id = entry.semantic_release_id
        and semantic_revision.semantic_entity_id = entry.semantic_entity_id
      left join public.curriculum_semantic_entity_revisions related_revision
        on related_revision.release_id = entry.semantic_release_id
        and related_revision.semantic_entity_id = entry.related_semantic_entity_id
      left join public.curriculum_node_revisions related_node
        on related_node.catalog_release_id = entry.catalog_release_id
        and related_node.textbook_id = entry.textbook_id
        and related_node.node_id = entry.related_curriculum_node_id
      where entry.owner_id = basis.owner_id and entry.basis_id = basis.id
    ), '[]'::jsonb)
  )
  from public.lesson_design_bases basis
  where basis.owner_id = p_owner_id and basis.lesson_file_id = p_lesson_file_id;
$$;

-- Existing lesson files receive an independent basis. Historical files cannot
-- be reliably reverse-linked to a blueprint, so only verified curriculum IDs
-- are pinned during backfill.
insert into public.lesson_design_bases(
  owner_id, notebook_id, lesson_file_id, catalog_release_id, textbook_id,
  curriculum_node_id, semantic_release_id, learner_context
)
select file.owner_id, file.notebook_id, file.id,
  verified.catalog_release_id, verified.textbook_id, verified.node_id,
  semantic.id, coalesce(file.context_profile, '{}'::jsonb)
from public.lesson_files file
left join lateral (
  select pointer.catalog_release_id,
    file.context_profile->>'textbookId' as textbook_id,
    coalesce(
      file.context_profile->>'lessonNodeId',
      file.context_profile->>'unitNodeId'
    ) as node_id
  from public.curriculum_catalog_current pointer
  join public.curriculum_node_revisions node
    on node.catalog_release_id = pointer.catalog_release_id
    and node.textbook_id = file.context_profile->>'textbookId'
    and node.node_id = coalesce(
      file.context_profile->>'lessonNodeId',
      file.context_profile->>'unitNodeId'
    )
  where pointer.singleton = true
  limit 1
) verified on true
left join lateral (
  select release.id
  from public.curriculum_semantic_releases release
  where release.catalog_release_id = verified.catalog_release_id
    and release.status = 'published'
    and exists (
      select 1 from public.curriculum_node_semantics mapping
      where mapping.release_id = release.id
        and mapping.textbook_id = verified.textbook_id
        and mapping.review_state = 'approved'
    )
  order by release.published_at desc, release.created_at desc
  limit 1
) semantic on true
on conflict (owner_id, lesson_file_id) do nothing;

insert into public.lesson_design_basis_versions(
  owner_id, basis_id, basis_version, snapshot, actor, idempotency_key, request_hash
)
select basis.owner_id, basis.id, 0,
  public.lesson_design_basis_snapshot(basis.owner_id, basis.lesson_file_id),
  'import', 'design-basis:backfill:' || basis.id::text,
  encode(extensions.digest(('design-basis:backfill:' || basis.id::text), 'sha256'), 'hex')
from public.lesson_design_bases basis
on conflict (owner_id, basis_id, basis_version) do nothing;

drop function if exists public.create_lesson_file(
  uuid,text,text,text,text,text,jsonb,integer,jsonb,text
);

create function public.create_lesson_file(
  p_owner_id uuid,
  p_file_id text,
  p_notebook_id text,
  p_title text,
  p_type text,
  p_image text,
  p_document jsonb,
  p_page_count integer,
  p_context_profile jsonb,
  p_lesson_blueprint_id uuid,
  p_idempotency_key text
)
returns public.lesson_files
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  created_file public.lesson_files;
  existing_version public.lesson_file_versions;
  request_hash text;
  blueprint public.lesson_blueprints;
  framework public.semester_frameworks;
  basis public.lesson_design_bases;
  verified_catalog_release_id uuid;
  verified_textbook_id text;
  verified_node_id text;
  verified_semantic_release_id uuid;
  selection record;
begin
  perform public.assert_service_scope(p_owner_id);
  request_hash := encode(extensions.digest(jsonb_build_object(
    'notebookId', p_notebook_id, 'title', p_title, 'type', p_type,
    'image', p_image, 'document', p_document, 'pageCount', p_page_count,
    'contextProfile', coalesce(p_context_profile, '{}'::jsonb),
    'lessonBlueprintId', p_lesson_blueprint_id
  )::text, 'sha256'), 'hex');

  select * into existing_version from public.lesson_file_versions
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_version.request_hash is not null
      and existing_version.request_hash <> request_hash
    then raise exception 'idempotency_conflict'; end if;
    select * into created_file from public.lesson_files
    where owner_id = p_owner_id and id = existing_version.lesson_file_id;
    return created_file;
  end if;

  if not exists (select 1 from public.notebooks
    where owner_id = p_owner_id and id = p_notebook_id)
  then raise exception 'notebook_not_found'; end if;

  if p_lesson_blueprint_id is not null then
    select * into blueprint from public.lesson_blueprints candidate
    where candidate.owner_id = p_owner_id and candidate.id = p_lesson_blueprint_id;
    if not found then raise exception 'lesson_blueprint_not_found'; end if;
    select * into framework from public.semester_frameworks candidate
    where candidate.owner_id = p_owner_id and candidate.id = blueprint.framework_id
      and candidate.notebook_id = p_notebook_id;
    if not found then raise exception 'lesson_blueprint_scope_invalid'; end if;
    verified_catalog_release_id := framework.catalog_release_id;
    verified_textbook_id := framework.textbook_id;
    verified_node_id := blueprint.curriculum_node_id;
    verified_semantic_release_id := framework.semantic_release_id;
  else
    select pointer.catalog_release_id,
      p_context_profile->>'textbookId',
      coalesce(p_context_profile->>'lessonNodeId', p_context_profile->>'unitNodeId')
    into verified_catalog_release_id, verified_textbook_id, verified_node_id
    from public.curriculum_catalog_current pointer
    join public.curriculum_node_revisions node
      on node.catalog_release_id = pointer.catalog_release_id
      and node.textbook_id = p_context_profile->>'textbookId'
      and node.node_id = coalesce(
        p_context_profile->>'lessonNodeId', p_context_profile->>'unitNodeId'
      )
    where pointer.singleton = true;
    if verified_catalog_release_id is not null then
      select release.id into verified_semantic_release_id
      from public.curriculum_semantic_releases release
      where release.catalog_release_id = verified_catalog_release_id
        and release.status = 'published'
        and exists (select 1 from public.curriculum_node_semantics mapping
          where mapping.release_id = release.id
            and mapping.textbook_id = verified_textbook_id
            and mapping.review_state = 'approved')
      order by release.published_at desc, release.created_at desc limit 1;
    end if;
  end if;

  insert into public.lesson_files(
    owner_id,id,notebook_id,title,type,image,document,page_count,context_profile
  ) values (
    p_owner_id,p_file_id,p_notebook_id,p_title,p_type,p_image,p_document,p_page_count,
    coalesce(p_context_profile, '{}'::jsonb)
  ) returning * into created_file;

  insert into public.lesson_file_versions(
    owner_id,lesson_file_id,document_version,document,page_count,actor,idempotency_key,request_hash
  ) values (
    p_owner_id,p_file_id,0,p_document,p_page_count,'import',p_idempotency_key,request_hash
  );

  insert into public.lesson_design_bases(
    owner_id, notebook_id, lesson_file_id, framework_id, semester_unit_id,
    lesson_blueprint_id, catalog_release_id, textbook_id, curriculum_node_id,
    semantic_release_id, source_framework_version, source_blueprint_version,
    learner_context
  ) values (
    p_owner_id, p_notebook_id, p_file_id, framework.id, blueprint.semester_unit_id,
    blueprint.id, verified_catalog_release_id, verified_textbook_id, verified_node_id,
    verified_semantic_release_id, framework.version, blueprint.version,
    coalesce(p_context_profile, '{}'::jsonb)
  ) returning * into basis;

  if blueprint.id is not null and verified_semantic_release_id is not null then
    for selection in
      select selected.*, revision.canonical_name,
        row_number() over (order by selected.priority, selected.created_at, selected.id) as design_sort_no,
        coalesce((select jsonb_agg(jsonb_build_object(
          'id', source.source_ref_id, 'title', source.title, 'url', source.url,
          'kind', source.source_kind
        ) order by source.created_at, source.id)
          from public.curriculum_semantic_entity_sources link
          join public.curriculum_semantic_sources source
            on source.release_id = link.release_id and source.id = link.source_id
          where link.release_id = selected.semantic_release_id
            and link.semantic_entity_id = selected.semantic_entity_id), '[]'::jsonb) as sources
      from public.framework_outcome_selections selected
      join public.curriculum_semantic_entity_revisions revision
        on revision.release_id = selected.semantic_release_id
        and revision.semantic_entity_id = selected.semantic_entity_id
      where selected.owner_id = p_owner_id
        and selected.framework_id = framework.id
        and selected.lesson_blueprint_id = blueprint.id
      order by selected.priority, selected.created_at, selected.id
    loop
      insert into public.lesson_design_basis_entries(
        owner_id, basis_id, semantic_release_id, catalog_release_id, textbook_id,
        kind, semantic_entity_id, statement, rationale, evidence, decision,
        teacher_confirmed, origin, sort_no
      ) values (
        p_owner_id, basis.id, verified_semantic_release_id,
        verified_catalog_release_id, verified_textbook_id, 'knowledge_point',
        selection.semantic_entity_id,
        '将“' || selection.canonical_name || '”作为本课需要落实的学习内容。',
        selection.adjustment_reason, selection.sources, 'accepted',
        selection.teacher_confirmed, 'platform', selection.design_sort_no
      );
    end loop;
  end if;

  insert into public.lesson_design_basis_versions(
    owner_id, basis_id, basis_version, snapshot, actor, idempotency_key, request_hash
  ) values (
    p_owner_id, basis.id, 0,
    public.lesson_design_basis_snapshot(p_owner_id, p_file_id),
    'import', 'design-basis:create:' || p_idempotency_key, request_hash
  );

  update public.notebooks set updated_at = now()
  where owner_id = p_owner_id and id = p_notebook_id;
  return created_file;
end;
$$;

create or replace function public.apply_lesson_design_basis_patch_internal(
  p_owner_id uuid,
  p_basis_id uuid,
  p_patch jsonb,
  p_actor text,
  p_run_id uuid,
  p_approval_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  basis public.lesson_design_bases;
  entry public.lesson_design_basis_entries;
  existing_version public.lesson_design_basis_versions;
  operation jsonb;
  target_key text;
  seen_targets text[] := array[]::text[];
  current_value jsonb;
  replacement jsonb;
  request_hash text;
  snapshot jsonb;
begin
  perform public.assert_service_scope(p_owner_id);
  request_hash := encode(extensions.digest(p_patch::text, 'sha256'), 'hex');
  select * into existing_version from public.lesson_design_basis_versions version_record
  where version_record.owner_id = p_owner_id
    and version_record.idempotency_key = p_idempotency_key;
  if found then
    if existing_version.basis_id <> p_basis_id
      or existing_version.request_hash <> request_hash
      or existing_version.approval_id is distinct from p_approval_id
    then raise exception 'idempotency_conflict'; end if;
    return existing_version.snapshot;
  end if;

  select * into basis from public.lesson_design_bases candidate
  where candidate.owner_id = p_owner_id and candidate.id = p_basis_id for update;
  if not found then raise exception 'lesson_design_basis_not_found'; end if;
  if p_patch->>'basisId' is distinct from basis.id::text
    or p_patch->>'fileId' is distinct from basis.lesson_file_id
  then raise exception 'design_basis_scope_invalid'; end if;

  for operation in
    select value from jsonb_array_elements(coalesce(p_patch->'operations', '[]'::jsonb))
  loop
    if operation->>'op' = 'replace_design_basis_field' then
      target_key := 'basis:' || (operation->>'field');
      current_value := case operation->>'field'
        when 'learnerContext' then basis.learner_context
        when 'teacherNotes' then to_jsonb(basis.teacher_notes)
        when 'status' then to_jsonb(basis.status)
        else null
      end;
      if current_value is null then raise exception 'invalid_design_basis_patch_field'; end if;
      replacement := operation->'replacement';
      if current_value is distinct from operation->'expectedValue' then raise exception 'stale_resource'; end if;
      if current_value = replacement then raise exception 'no_effect_patch'; end if;
      update public.lesson_design_bases set
        learner_context = case when operation->>'field' = 'learnerContext' then replacement else learner_context end,
        teacher_notes = case when operation->>'field' = 'teacherNotes' then operation->>'replacement' else teacher_notes end,
        status = case when operation->>'field' = 'status' then operation->>'replacement' else status end
      where owner_id = p_owner_id and id = basis.id returning * into basis;
    elsif operation->>'op' = 'create_design_basis_entry' then
      target_key := 'entry:create:' || (operation->>'entryId');
      if exists (select 1 from public.lesson_design_basis_entries candidate
        where candidate.owner_id = p_owner_id and candidate.id = (operation->>'entryId')::uuid)
      then raise exception 'duplicate_design_basis_entry_id'; end if;
      insert into public.lesson_design_basis_entries(
        id, owner_id, basis_id, semantic_release_id, catalog_release_id, textbook_id,
        kind, semantic_entity_id, related_semantic_entity_id,
        related_curriculum_node_id, statement, rationale, evidence, decision,
        teacher_confirmed, origin, sort_no
      ) values (
        (operation->>'entryId')::uuid, p_owner_id, basis.id,
        case when operation->>'semanticEntityId' is null then null else basis.semantic_release_id end,
        case when operation->>'semanticEntityId' is null then null else basis.catalog_release_id end,
        case when operation->>'semanticEntityId' is null then null else basis.textbook_id end,
        operation->>'kind', (operation->>'semanticEntityId')::uuid,
        (operation->>'relatedSemanticEntityId')::uuid,
        operation->>'relatedCurriculumNodeId', operation->>'statement',
        coalesce(operation->>'rationale', ''), coalesce(operation->'evidence', '[]'::jsonb),
        coalesce(operation->>'decision', 'accepted'),
        coalesce((operation->>'teacherConfirmed')::boolean, true),
        coalesce(operation->>'origin', case when p_actor = 'agent' then 'agent' else 'teacher' end),
        (operation->>'sortNo')::integer
      );
    else
      select * into entry from public.lesson_design_basis_entries candidate
      where candidate.owner_id = p_owner_id and candidate.basis_id = basis.id
        and candidate.id = (operation->>'entryId')::uuid for update;
      if not found then raise exception 'design_basis_entry_not_found'; end if;
      if operation->>'op' = 'delete_design_basis_entry' then
        target_key := 'entry:delete:' || entry.id::text;
        if entry.version <> (operation->>'expectedVersion')::integer then raise exception 'stale_resource'; end if;
        delete from public.lesson_design_basis_entries
        where owner_id = p_owner_id and basis_id = basis.id and id = entry.id;
      elsif operation->>'op' = 'replace_design_basis_entry_field' then
        target_key := 'entry:' || entry.id::text || ':' || (operation->>'field');
        current_value := case operation->>'field'
          when 'statement' then to_jsonb(entry.statement)
          when 'rationale' then to_jsonb(entry.rationale)
          when 'evidence' then entry.evidence
          when 'decision' then to_jsonb(entry.decision)
          else null
        end;
        if current_value is null then raise exception 'invalid_design_basis_patch_field'; end if;
        replacement := operation->'replacement';
        if current_value is distinct from operation->'expectedValue' then raise exception 'stale_resource'; end if;
        if current_value = replacement then raise exception 'no_effect_patch'; end if;
        update public.lesson_design_basis_entries set
          statement = case when operation->>'field' = 'statement' then operation->>'replacement' else statement end,
          rationale = case when operation->>'field' = 'rationale' then operation->>'replacement' else rationale end,
          evidence = case when operation->>'field' = 'evidence' then replacement else evidence end,
          decision = case when operation->>'field' = 'decision' then operation->>'replacement' else decision end,
          teacher_confirmed = true,
          version = version + 1,
          updated_at = now()
        where owner_id = p_owner_id and basis_id = basis.id and id = entry.id;
      else
        raise exception 'invalid_design_basis_patch_operation';
      end if;
    end if;
    if target_key = any(seen_targets) then raise exception 'duplicate_design_basis_patch_target'; end if;
    seen_targets := array_append(seen_targets, target_key);
  end loop;

  if cardinality(seen_targets) = 0 then raise exception 'empty_patch'; end if;
  update public.lesson_design_bases
  set version = version + 1, updated_at = now()
  where owner_id = p_owner_id and id = basis.id returning * into basis;
  if p_approval_id is not null then
    update public.agent_approvals set state = 'approved'
    where owner_id = p_owner_id and id = p_approval_id;
  end if;
  snapshot := public.lesson_design_basis_snapshot(p_owner_id, basis.lesson_file_id);
  insert into public.lesson_design_basis_versions(
    owner_id, basis_id, basis_version, snapshot, actor, run_id, approval_id,
    idempotency_key, request_hash
  ) values (
    p_owner_id, basis.id, basis.version, snapshot, p_actor, p_run_id,
    p_approval_id, p_idempotency_key, request_hash
  );
  return snapshot;
end;
$$;

create or replace function public.apply_manual_lesson_design_basis_patch(
  p_owner_id uuid, p_basis_id uuid, p_patch jsonb, p_idempotency_key text
)
returns jsonb language sql security definer set search_path = public
as $$
  select public.apply_lesson_design_basis_patch_internal(
    p_owner_id, p_basis_id, p_patch, 'manual', null, null, p_idempotency_key
  );
$$;

alter table public.agent_approvals
  drop constraint agent_approvals_patch_kind_check,
  drop constraint agent_approvals_resource_shape_check;
alter table public.agent_approvals
  add constraint agent_approvals_patch_kind_check check (patch_kind in (
    'document', 'semester_framework', 'lesson_blueprint', 'lesson_design_basis'
  )),
  add constraint agent_approvals_resource_shape_check check (
    (resource_type = 'lesson_file'
      and patch_kind = 'document'
      and lesson_file_id is not null
      and semester_framework_id is null
      and document_version is not null)
    or
    (resource_type = 'lesson_file'
      and patch_kind = 'lesson_design_basis'
      and lesson_file_id is not null
      and semester_framework_id is null
      and document_version is null)
    or
    (resource_type = 'semester_framework'
      and patch_kind in ('semester_framework', 'lesson_blueprint')
      and lesson_file_id is null
      and semester_framework_id is not null
      and document_version is null)
  );

create or replace function public.apply_approved_lesson_design_basis_patch(
  p_owner_id uuid, p_approval_id uuid, p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  approval public.agent_approvals;
  basis public.lesson_design_bases;
begin
  perform public.assert_service_scope(p_owner_id);
  select * into approval from public.agent_approvals candidate
  where candidate.owner_id = p_owner_id and candidate.id = p_approval_id for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.state <> 'pending' then raise exception 'approval_not_approvable'; end if;
  if approval.resource_type <> 'lesson_file'
    or approval.patch_kind <> 'lesson_design_basis'
    or approval.lesson_file_id is null
  then raise exception 'approval_resource_scope_invalid'; end if;
  select * into basis from public.lesson_design_bases candidate
  where candidate.owner_id = p_owner_id
    and candidate.lesson_file_id = approval.lesson_file_id;
  if not found or approval.patch->>'basisId' is distinct from basis.id::text
  then raise exception 'approval_resource_scope_invalid'; end if;
  return public.apply_lesson_design_basis_patch_internal(
    p_owner_id, basis.id, approval.patch, 'agent', approval.run_id,
    p_approval_id, p_idempotency_key
  );
end;
$$;

create or replace function public.decide_agent_approval(
  p_owner_id uuid,
  p_approval_id uuid,
  p_approved boolean,
  p_encrypted_run_state text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  approval public.agent_approvals;
  file public.lesson_files;
  framework jsonb;
  basis jsonb;
  desired_state text;
begin
  perform public.assert_service_scope(p_owner_id);
  desired_state := case when p_approved then 'approved' else 'rejected' end;
  select * into approval from public.agent_approvals
  where owner_id = p_owner_id and id = p_approval_id for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.expires_at <= now() or approval.state = 'expired' then raise exception 'approval_expired'; end if;
  if approval.state <> 'pending' and approval.state <> desired_state
  then raise exception 'approval_already_resolved'; end if;

  if approval.state = 'pending' then
    if p_approved and approval.patch_kind = 'lesson_design_basis' then
      basis := public.apply_approved_lesson_design_basis_patch(
        p_owner_id, p_approval_id, 'approval:' || p_approval_id::text
      );
    elsif p_approved and approval.resource_type = 'semester_framework' then
      framework := public.apply_approved_semester_framework_patch(
        p_owner_id, p_approval_id, 'approval:' || p_approval_id::text
      );
    elsif p_approved then
      file := public.apply_approved_document_patch(
        p_owner_id, p_approval_id, 'approval:' || p_approval_id::text
      );
    else
      update public.agent_approvals set state = 'rejected'
      where owner_id = p_owner_id and id = p_approval_id;
    end if;
  elsif p_approved and approval.patch_kind = 'lesson_design_basis' then
    basis := public.lesson_design_basis_snapshot(p_owner_id, approval.lesson_file_id);
  elsif p_approved and approval.resource_type = 'semester_framework' then
    framework := public.semester_framework_snapshot(p_owner_id, approval.semester_framework_id);
  elsif p_approved then
    select * into file from public.lesson_files
    where owner_id = p_owner_id and id = approval.lesson_file_id;
  end if;

  update public.agent_approvals
  set encrypted_run_state = p_encrypted_run_state,
      continuation_status = case when continuation_status = 'completed' then 'completed' else 'ready' end,
      continuation_lease_token = null,
      continuation_lease_expires_at = null,
      continuation_error = null,
      continuation_message_id = coalesce(continuation_message_id, gen_random_uuid())
  where owner_id = p_owner_id and id = p_approval_id returning * into approval;

  return jsonb_build_object(
    'approval', to_jsonb(approval), 'file', to_jsonb(file),
    'framework', framework, 'basis', basis
  );
end;
$$;

revoke all on function public.lesson_design_basis_snapshot(uuid, text),
  public.create_lesson_file(uuid,text,text,text,text,text,jsonb,integer,jsonb,uuid,text),
  public.apply_lesson_design_basis_patch_internal(uuid,uuid,jsonb,text,uuid,uuid,text),
  public.apply_manual_lesson_design_basis_patch(uuid,uuid,jsonb,text),
  public.apply_approved_lesson_design_basis_patch(uuid,uuid,text),
  public.decide_agent_approval(uuid,uuid,boolean,text)
from public, anon, authenticated;
grant execute on function public.lesson_design_basis_snapshot(uuid, text),
  public.create_lesson_file(uuid,text,text,text,text,text,jsonb,integer,jsonb,uuid,text),
  public.apply_lesson_design_basis_patch_internal(uuid,uuid,jsonb,text,uuid,uuid,text),
  public.apply_manual_lesson_design_basis_patch(uuid,uuid,jsonb,text),
  public.apply_approved_lesson_design_basis_patch(uuid,uuid,text),
  public.decide_agent_approval(uuid,uuid,boolean,text)
to service_role;
