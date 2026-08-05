-- Give every chapter period a stable business identity. Unit chronology
-- (planned_period) remains a schedule position; chapter_period_no identifies
-- "this chapter's first/second/... lesson" across replanning.

alter table public.lesson_blueprints
  add column if not exists chapter_period_no integer;

with ranked as (
  select id,
    row_number() over (
      partition by owner_id, framework_id, semester_unit_id, curriculum_node_id
      order by planned_period, sort_no, id
    ) as chapter_period_no
  from public.lesson_blueprints
)
update public.lesson_blueprints blueprint
set chapter_period_no = ranked.chapter_period_no
from ranked
where ranked.id = blueprint.id and blueprint.chapter_period_no is null;

alter table public.lesson_blueprints
  alter column chapter_period_no set not null;
alter table public.lesson_blueprints
  drop constraint if exists lesson_blueprints_chapter_period_no_check;
alter table public.lesson_blueprints
  add constraint lesson_blueprints_chapter_period_no_check
  check (chapter_period_no between 1 and 100);

create unique index if not exists lesson_blueprints_chapter_period_identity_idx
  on public.lesson_blueprints(
    owner_id, framework_id, semester_unit_id, curriculum_node_id, chapter_period_no
  );

-- A blueprint is still one real classroom period. Its duration is editable,
-- but chapter totals such as 80/120 minutes cannot be stored as one period.
drop trigger if exists semester_frameworks_sync_blueprint_minutes
  on public.semester_frameworks;
drop function if exists public.sync_blueprint_minutes_after_framework_change();
drop trigger if exists lesson_blueprints_single_period_minutes
  on public.lesson_blueprints;
drop function if exists public.enforce_single_period_blueprint_minutes();

update public.lesson_blueprints blueprint
set planned_minutes = framework.lesson_duration_minutes
from public.semester_frameworks framework
where framework.owner_id = blueprint.owner_id
  and framework.id = blueprint.framework_id
  and (blueprint.planned_minutes is null or blueprint.planned_minutes not between 20 and 60);

alter table public.lesson_blueprints
  drop constraint if exists lesson_blueprints_planned_minutes_check;
alter table public.lesson_blueprints
  add constraint lesson_blueprints_planned_minutes_check
  check (planned_minutes between 20 and 60);
alter table public.lesson_blueprints
  alter column planned_minutes set not null;

create or replace function public.bind_lesson_blueprint_period_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  framework_minutes integer;
  approved_period_no integer;
begin
  select framework.lesson_duration_minutes into framework_minutes
  from public.semester_frameworks framework
  where framework.owner_id = new.owner_id and framework.id = new.framework_id;
  if framework_minutes is null then raise exception 'semester_framework_not_found'; end if;
  new.planned_minutes := coalesce(new.planned_minutes, framework_minutes);

  if new.chapter_period_no is null then
    -- Agent-created records already have a validated operation in their
    -- pending approval. Manual creation has no approval and falls back to the
    -- next chapter period.
    select (operation->>'chapterPeriodNo')::integer into approved_period_no
    from public.agent_approvals approval
    cross join lateral jsonb_array_elements(coalesce(approval.patch->'operations', '[]'::jsonb)) operation
    where approval.owner_id = new.owner_id
      and approval.state = 'pending'
      and operation->>'op' = 'create_lesson_blueprint'
      and operation->>'blueprintId' = new.id::text
    limit 1;
    new.chapter_period_no := approved_period_no;
  end if;

  if new.chapter_period_no is null then
    select coalesce(max(candidate.chapter_period_no), 0) + 1
    into new.chapter_period_no
    from public.lesson_blueprints candidate
    where candidate.owner_id = new.owner_id
      and candidate.framework_id = new.framework_id
      and candidate.semester_unit_id = new.semester_unit_id
      and candidate.curriculum_node_id = new.curriculum_node_id;
  end if;

  if exists (
    select 1 from public.lesson_blueprints candidate
    where candidate.owner_id = new.owner_id
      and candidate.framework_id = new.framework_id
      and candidate.semester_unit_id = new.semester_unit_id
      and candidate.curriculum_node_id = new.curriculum_node_id
      and candidate.chapter_period_no = new.chapter_period_no
      and candidate.id <> new.id
  ) then raise exception 'duplicate_lesson_blueprint_identity'; end if;
  return new;
end;
$$;

create trigger lesson_blueprints_bind_period_identity
before insert or update of owner_id, framework_id, semester_unit_id,
  curriculum_node_id, chapter_period_no, planned_minutes
on public.lesson_blueprints
for each row execute function public.bind_lesson_blueprint_period_identity();

revoke all on function public.bind_lesson_blueprint_period_identity()
from public, anon, authenticated;
grant execute on function public.bind_lesson_blueprint_period_identity()
to service_role;

-- Persist the blueprint/file relationship on the file itself. Design basis
-- remains the rich provenance layer, while this column makes the user-facing
-- lifecycle (view/regenerate/delete) direct and unambiguous.
alter table public.lesson_files
  add column if not exists lesson_blueprint_id uuid
    references public.lesson_blueprints(id) on delete set null;

update public.lesson_files file
set lesson_blueprint_id = basis.lesson_blueprint_id
from public.lesson_design_bases basis
where basis.owner_id = file.owner_id
  and basis.lesson_file_id = file.id
  and basis.lesson_blueprint_id is not null
  and file.lesson_blueprint_id is null;

create unique index if not exists lesson_files_blueprint_unique_idx
  on public.lesson_files(owner_id, lesson_blueprint_id)
  where lesson_blueprint_id is not null;

create or replace function public.bind_lesson_file_to_design_basis_blueprint()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.lesson_blueprint_id is not null then
    update public.lesson_files
    set lesson_blueprint_id = new.lesson_blueprint_id
    where owner_id = new.owner_id and id = new.lesson_file_id;
  end if;
  return new;
exception
  when unique_violation then
    raise exception 'lesson_blueprint_lesson_exists';
end;
$$;

drop trigger if exists lesson_design_basis_bind_lesson_file_blueprint
  on public.lesson_design_bases;
create trigger lesson_design_basis_bind_lesson_file_blueprint
after insert or update of lesson_blueprint_id
on public.lesson_design_bases
for each row execute function public.bind_lesson_file_to_design_basis_blueprint();

revoke all on function public.bind_lesson_file_to_design_basis_blueprint()
from public, anon, authenticated;
grant execute on function public.bind_lesson_file_to_design_basis_blueprint()
to service_role;
