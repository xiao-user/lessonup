create or replace function public._lessonup_blueprint_title_key(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(p_value, '')), '[^0-9a-z一-龥]+', '', 'g'),
      '^[0-9]+', ''
    ),
    '^(写作|专题学习活动|整本书阅读)', ''
  );
$$;

create temporary table lessonup_blueprint_node_repairs on commit drop as
with recursive descendants as (
  select
    unit.owner_id,
    unit.framework_id,
    unit.id as semester_unit_id,
    revision.node_id,
    revision.title
  from public.semester_units unit
  join public.curriculum_node_revisions revision
    on revision.catalog_release_id = unit.catalog_release_id
   and revision.textbook_id = unit.textbook_id
   and revision.parent_id = unit.curriculum_node_id
  union all
  select
    parent.owner_id,
    parent.framework_id,
    parent.semester_unit_id,
    child.node_id,
    child.title
  from descendants parent
  join public.semester_units unit
    on unit.owner_id = parent.owner_id
   and unit.framework_id = parent.framework_id
   and unit.id = parent.semester_unit_id
  join public.curriculum_node_revisions child
    on child.catalog_release_id = unit.catalog_release_id
   and child.textbook_id = unit.textbook_id
   and child.parent_id = parent.node_id
), unique_matches as (
  select
    blueprint.owner_id,
    blueprint.framework_id,
    blueprint.id as blueprint_id,
    min(candidate.node_id) as node_id,
    count(*) as match_count
  from public.lesson_blueprints blueprint
  join public.semester_units unit
    on unit.owner_id = blueprint.owner_id
   and unit.framework_id = blueprint.framework_id
   and unit.id = blueprint.semester_unit_id
  join descendants candidate
    on candidate.owner_id = blueprint.owner_id
   and candidate.framework_id = blueprint.framework_id
   and candidate.semester_unit_id = blueprint.semester_unit_id
   and public._lessonup_blueprint_title_key(candidate.title)
       = public._lessonup_blueprint_title_key(blueprint.title)
  where blueprint.curriculum_node_id = unit.curriculum_node_id
    and public._lessonup_blueprint_title_key(blueprint.title) <> ''
  group by blueprint.owner_id, blueprint.framework_id, blueprint.id
)
select owner_id, framework_id, blueprint_id, node_id
from unique_matches
where match_count = 1;

create temporary table lessonup_repaired_frameworks on commit drop as
select distinct owner_id, framework_id
from lessonup_blueprint_node_repairs;

update public.lesson_blueprints blueprint
set curriculum_node_id = repair.node_id,
    version = blueprint.version + 1,
    updated_at = now()
from lessonup_blueprint_node_repairs repair
where blueprint.owner_id = repair.owner_id
  and blueprint.framework_id = repair.framework_id
  and blueprint.id = repair.blueprint_id;

update public.lesson_files lesson_file
set context_profile = jsonb_set(
      coalesce(lesson_file.context_profile, '{}'::jsonb),
      '{lessonNodeId}',
      to_jsonb(repair.node_id),
      true
    ),
    updated_at = now()
from lessonup_blueprint_node_repairs repair
join public.lesson_design_bases basis
  on basis.owner_id = repair.owner_id
 and basis.lesson_blueprint_id = repair.blueprint_id
where lesson_file.owner_id = basis.owner_id
  and lesson_file.id = basis.lesson_file_id;

update public.semester_frameworks framework
set version = framework.version + 1,
    updated_at = now()
from lessonup_repaired_frameworks repaired
where framework.owner_id = repaired.owner_id
  and framework.id = repaired.framework_id;

insert into public.semester_framework_versions(
  owner_id,
  framework_id,
  framework_version,
  snapshot,
  actor,
  idempotency_key,
  request_hash
)
select
  framework.owner_id,
  framework.id,
  framework.version,
  public.semester_framework_snapshot(framework.owner_id, framework.id),
  'import',
  'migration:202608030002:' || framework.id::text,
  encode(extensions.digest(
    ('repair_blueprint_chapter_bindings:' || framework.id::text)::bytea,
    'sha256'
  ), 'hex')
from public.semester_frameworks framework
join lessonup_repaired_frameworks repaired
  on repaired.owner_id = framework.owner_id
 and repaired.framework_id = framework.id;

create temporary table lessonup_repaired_bases on commit drop as
select basis.owner_id, basis.id as basis_id, basis.lesson_file_id
from public.lesson_design_bases basis
join lessonup_blueprint_node_repairs repair
  on repair.owner_id = basis.owner_id
 and repair.blueprint_id = basis.lesson_blueprint_id;

update public.lesson_design_bases basis
set curriculum_node_id = repair.node_id,
    source_blueprint_version = blueprint.version,
    source_framework_version = framework.version,
    version = basis.version + 1,
    updated_at = now()
from lessonup_blueprint_node_repairs repair
join public.lesson_blueprints blueprint
  on blueprint.owner_id = repair.owner_id
 and blueprint.id = repair.blueprint_id
join public.semester_frameworks framework
  on framework.owner_id = repair.owner_id
 and framework.id = repair.framework_id
where basis.owner_id = repair.owner_id
  and basis.lesson_blueprint_id = repair.blueprint_id;

insert into public.lesson_design_basis_versions(
  owner_id,
  basis_id,
  basis_version,
  snapshot,
  actor,
  idempotency_key,
  request_hash
)
select
  basis.owner_id,
  basis.id,
  basis.version,
  public.lesson_design_basis_snapshot(basis.owner_id, basis.lesson_file_id),
  'import',
  'migration:202608030002:basis:' || basis.id::text,
  encode(extensions.digest(
    ('repair_blueprint_chapter_binding_basis:' || basis.id::text)::bytea,
    'sha256'
  ), 'hex')
from public.lesson_design_bases basis
join lessonup_repaired_bases repaired
  on repaired.owner_id = basis.owner_id
 and repaired.basis_id = basis.id;

drop function public._lessonup_blueprint_title_key(text);
