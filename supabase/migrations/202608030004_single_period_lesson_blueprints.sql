-- A lesson blueprint is one schedulable classroom period, never an aggregate
-- chapter duration. Chapter period count remains derived from repeated
-- curriculum_node_id occurrences and the published period recommendations.

update public.semester_frameworks
set lesson_duration_minutes = case
  when lesson_duration_minutes <= 42 then 40
  else 45
end
where lesson_duration_minutes not in (40, 45);

alter table public.semester_frameworks
  drop constraint if exists semester_frameworks_lesson_duration_minutes_check;
alter table public.semester_frameworks
  add constraint semester_frameworks_lesson_duration_minutes_check
  check (lesson_duration_minutes in (40, 45));

update public.lesson_blueprints blueprint
set planned_minutes = framework.lesson_duration_minutes
from public.semester_frameworks framework
where framework.owner_id = blueprint.owner_id
  and framework.id = blueprint.framework_id
  and blueprint.planned_minutes is distinct from framework.lesson_duration_minutes;

create or replace function public.enforce_single_period_blueprint_minutes()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  period_minutes integer;
begin
  select framework.lesson_duration_minutes into period_minutes
  from public.semester_frameworks framework
  where framework.owner_id = new.owner_id
    and framework.id = new.framework_id;
  if period_minutes is null then
    raise exception 'semester_framework_not_found';
  end if;
  new.planned_minutes := period_minutes;
  return new;
end;
$$;

drop trigger if exists lesson_blueprints_single_period_minutes
on public.lesson_blueprints;
create trigger lesson_blueprints_single_period_minutes
before insert or update of owner_id, framework_id, planned_minutes
on public.lesson_blueprints
for each row execute function public.enforce_single_period_blueprint_minutes();

create or replace function public.sync_blueprint_minutes_after_framework_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.lesson_duration_minutes is distinct from old.lesson_duration_minutes then
    update public.lesson_blueprints
    set planned_minutes = new.lesson_duration_minutes
    where owner_id = new.owner_id and framework_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists semester_frameworks_sync_blueprint_minutes
on public.semester_frameworks;
create trigger semester_frameworks_sync_blueprint_minutes
after update of lesson_duration_minutes
on public.semester_frameworks
for each row execute function public.sync_blueprint_minutes_after_framework_change();

revoke all on function public.enforce_single_period_blueprint_minutes(),
  public.sync_blueprint_minutes_after_framework_change()
from public, anon, authenticated;
