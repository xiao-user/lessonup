-- Transactional manual planning. Manual edits and blueprint changes share the
-- same aggregate version history as Agent-approved framework patches.

create or replace function public.apply_manual_semester_framework_patch(
  p_owner_id uuid,
  p_framework_id uuid,
  p_patch jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  framework public.semester_frameworks%rowtype;
  existing_version public.semester_framework_versions%rowtype;
  operation jsonb;
  unit_record public.semester_units%rowtype;
  current_value jsonb;
  replacement jsonb;
  target_key text;
  seen_targets text[] := array[]::text[];
  touched_units uuid[] := array[]::uuid[];
  request_hash text;
  snapshot jsonb;
begin
  perform public.assert_service_scope(p_owner_id);
  request_hash := encode(extensions.digest(p_patch::text, 'sha256'), 'hex');

  select * into existing_version
  from public.semester_framework_versions version_record
  where version_record.owner_id = p_owner_id
    and version_record.idempotency_key = p_idempotency_key;
  if found then
    if existing_version.framework_id <> p_framework_id
      or existing_version.request_hash <> request_hash
    then
      raise exception 'idempotency_conflict';
    end if;
    return existing_version.snapshot;
  end if;

  if p_patch->>'frameworkId' is distinct from p_framework_id::text then
    raise exception 'semester_framework_scope_invalid';
  end if;

  select * into framework
  from public.semester_frameworks framework_record
  where framework_record.owner_id = p_owner_id
    and framework_record.id = p_framework_id
  for update;
  if not found then raise exception 'semester_framework_not_found'; end if;

  for operation in
    select value from jsonb_array_elements(coalesce(p_patch->'operations', '[]'::jsonb))
  loop
    if operation->>'op' = 'replace_framework_field' then
      target_key := 'framework:' || (operation->>'field');
    elsif operation->>'op' = 'replace_unit_field' then
      target_key := 'unit:' || (operation->>'unitId') || ':' || (operation->>'field');
    else
      raise exception 'invalid_framework_patch_operation';
    end if;
    if target_key = any(seen_targets) then
      raise exception 'duplicate_framework_patch_target';
    end if;
    seen_targets := array_append(seen_targets, target_key);

    replacement := operation->'replacement';
    if operation->>'op' = 'replace_framework_field' then
      current_value := case operation->>'field'
        when 'title' then to_jsonb(framework.title)
        when 'term' then to_jsonb(framework.term)
        when 'startDate' then coalesce(to_jsonb(framework.start_date::text), 'null'::jsonb)
        when 'totalWeeks' then to_jsonb(framework.total_weeks)
        when 'weeklyPeriods' then to_jsonb(framework.weekly_periods)
        when 'lessonDurationMinutes' then to_jsonb(framework.lesson_duration_minutes)
        when 'capacityRatio' then to_jsonb(framework.capacity_ratio)
        when 'planningHorizonWeeks' then to_jsonb(framework.planning_horizon_weeks)
        when 'contextProfile' then framework.context_profile
        when 'status' then to_jsonb(framework.status)
        else null
      end;
      if current_value is null then raise exception 'invalid_framework_patch_field'; end if;
      if current_value is distinct from operation->'expectedValue' then
        raise exception 'stale_resource';
      end if;
      if current_value = replacement then raise exception 'no_effect_patch'; end if;

      update public.semester_frameworks
      set title = case when operation->>'field' = 'title' then operation->>'replacement' else title end,
          term = case when operation->>'field' = 'term' then operation->>'replacement' else term end,
          start_date = case when operation->>'field' = 'startDate'
            then (operation->>'replacement')::date else start_date end,
          total_weeks = case when operation->>'field' = 'totalWeeks'
            then (operation->>'replacement')::integer else total_weeks end,
          weekly_periods = case when operation->>'field' = 'weeklyPeriods'
            then (operation->>'replacement')::integer else weekly_periods end,
          lesson_duration_minutes = case when operation->>'field' = 'lessonDurationMinutes'
            then (operation->>'replacement')::integer else lesson_duration_minutes end,
          capacity_ratio = case when operation->>'field' = 'capacityRatio'
            then (operation->>'replacement')::numeric else capacity_ratio end,
          planning_horizon_weeks = case when operation->>'field' = 'planningHorizonWeeks'
            then (operation->>'replacement')::integer else planning_horizon_weeks end,
          context_profile = case when operation->>'field' = 'contextProfile'
            then replacement else context_profile end,
          status = case when operation->>'field' = 'status'
            then operation->>'replacement' else status end
      where owner_id = p_owner_id and id = p_framework_id;
    else
      select * into unit_record
      from public.semester_units candidate
      where candidate.owner_id = p_owner_id
        and candidate.framework_id = p_framework_id
        and candidate.id = (operation->>'unitId')::uuid
      for update;
      if not found then raise exception 'semester_unit_not_found'; end if;
      current_value := case operation->>'field'
        when 'plannedStartWeek' then coalesce(to_jsonb(unit_record.planned_start_week), 'null'::jsonb)
        when 'plannedEndWeek' then coalesce(to_jsonb(unit_record.planned_end_week), 'null'::jsonb)
        when 'plannedPeriods' then to_jsonb(unit_record.planned_periods)
        when 'learningGoals' then to_jsonb(unit_record.learning_goals)
        when 'teacherNotes' then to_jsonb(unit_record.teacher_notes)
        when 'status' then to_jsonb(unit_record.status)
        else null
      end;
      if current_value is null then raise exception 'invalid_framework_patch_field'; end if;
      if current_value is distinct from operation->'expectedValue' then
        raise exception 'stale_resource';
      end if;
      if current_value = replacement then raise exception 'no_effect_patch'; end if;

      update public.semester_units
      set planned_start_week = case when operation->>'field' = 'plannedStartWeek'
            then (operation->>'replacement')::integer else planned_start_week end,
          planned_end_week = case when operation->>'field' = 'plannedEndWeek'
            then (operation->>'replacement')::integer else planned_end_week end,
          planned_periods = case when operation->>'field' = 'plannedPeriods'
            then (operation->>'replacement')::integer else planned_periods end,
          learning_goals = case when operation->>'field' = 'learningGoals'
            then operation->>'replacement' else learning_goals end,
          teacher_notes = case when operation->>'field' = 'teacherNotes'
            then operation->>'replacement' else teacher_notes end,
          status = case when operation->>'field' = 'status'
            then operation->>'replacement' else status end,
          updated_at = now()
      where owner_id = p_owner_id and framework_id = p_framework_id and id = unit_record.id;
      if not unit_record.id = any(touched_units) then
        touched_units := array_append(touched_units, unit_record.id);
      end if;
    end if;
  end loop;

  if cardinality(seen_targets) = 0 then raise exception 'empty_patch'; end if;
  if exists (
    select 1 from public.semester_frameworks candidate
    where candidate.owner_id = p_owner_id and candidate.id = p_framework_id
      and candidate.planning_horizon_weeks > candidate.total_weeks
  ) then raise exception 'planning_horizon_exceeds_term'; end if;
  if exists (
    select 1
    from public.semester_units unit_candidate
    join public.semester_frameworks candidate
      on candidate.owner_id = unit_candidate.owner_id and candidate.id = unit_candidate.framework_id
    where unit_candidate.owner_id = p_owner_id and unit_candidate.framework_id = p_framework_id
      and (
        (unit_candidate.planned_start_week is not null and unit_candidate.planned_start_week > candidate.total_weeks)
        or (unit_candidate.planned_end_week is not null and unit_candidate.planned_end_week > candidate.total_weeks)
        or (unit_candidate.planned_start_week is not null and unit_candidate.planned_end_week is not null
          and unit_candidate.planned_start_week > unit_candidate.planned_end_week)
      )
  ) then raise exception 'semester_unit_week_range_invalid'; end if;

  update public.semester_units
  set version = version + 1
  where owner_id = p_owner_id and framework_id = p_framework_id and id = any(touched_units);
  update public.semester_frameworks
  set version = version + 1, updated_at = now()
  where owner_id = p_owner_id and id = p_framework_id
  returning * into framework;
  update public.framework_continuity_candidates
  set active = false, updated_at = now()
  where owner_id = p_owner_id and framework_id = p_framework_id and active;

  snapshot := public.semester_framework_snapshot(p_owner_id, p_framework_id);
  insert into public.semester_framework_versions(
    owner_id, framework_id, framework_version, snapshot, actor,
    idempotency_key, request_hash
  ) values (
    p_owner_id, p_framework_id, framework.version, snapshot, 'manual',
    p_idempotency_key, request_hash
  );
  return snapshot;
end;
$$;

create or replace function public.create_lesson_blueprint(
  p_owner_id uuid,
  p_framework_id uuid,
  p_blueprint_id uuid,
  p_input jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  framework public.semester_frameworks%rowtype;
  unit_record public.semester_units%rowtype;
  existing_version public.semester_framework_versions%rowtype;
  request_hash text;
  next_period integer;
  next_sort integer;
  snapshot jsonb;
begin
  perform public.assert_service_scope(p_owner_id);
  request_hash := encode(extensions.digest(jsonb_build_object(
    'frameworkId', p_framework_id, 'input', p_input
  )::text, 'sha256'), 'hex');
  select * into existing_version from public.semester_framework_versions version_record
  where version_record.owner_id = p_owner_id
    and version_record.idempotency_key = p_idempotency_key;
  if found then
    if existing_version.framework_id <> p_framework_id
      or existing_version.request_hash <> request_hash
    then raise exception 'idempotency_conflict'; end if;
    return existing_version.snapshot;
  end if;

  select * into framework from public.semester_frameworks candidate
  where candidate.owner_id = p_owner_id and candidate.id = p_framework_id for update;
  if not found then raise exception 'semester_framework_not_found'; end if;
  select * into unit_record from public.semester_units candidate
  where candidate.owner_id = p_owner_id and candidate.framework_id = p_framework_id
    and candidate.id = (p_input->>'semesterUnitId')::uuid for update;
  if not found then raise exception 'semester_unit_not_found'; end if;

  if not exists (
    with recursive subtree as (
      select revision.node_id
      from public.curriculum_node_revisions revision
      where revision.catalog_release_id = framework.catalog_release_id
        and revision.textbook_id = framework.textbook_id
        and revision.node_id = unit_record.curriculum_node_id
      union all
      select child.node_id
      from public.curriculum_node_revisions child
      join subtree parent on child.parent_id = parent.node_id
      where child.catalog_release_id = framework.catalog_release_id
        and child.textbook_id = framework.textbook_id
    ) select 1 from subtree where node_id = p_input->>'curriculumNodeId'
  ) then raise exception 'curriculum_node_outside_semester_unit'; end if;
  if jsonb_typeof(coalesce(p_input->'anticipatedDifficulties', '[]'::jsonb)) <> 'array'
  then raise exception 'invalid_blueprint_difficulties'; end if;

  select coalesce(max(planned_period), 0) + 1 into next_period
  from public.lesson_blueprints where owner_id = p_owner_id
    and framework_id = p_framework_id and semester_unit_id = unit_record.id;
  select coalesce(max(sort_no), 0) + 1 into next_sort
  from public.lesson_blueprints where owner_id = p_owner_id and framework_id = p_framework_id;

  insert into public.lesson_blueprints(
    id, owner_id, framework_id, semester_unit_id, catalog_release_id, textbook_id,
    curriculum_node_id, planned_period, sort_no, title, main_activity,
    observable_product, assessment_evidence, anticipated_difficulties,
    planned_minutes, teacher_notes
  ) values (
    p_blueprint_id, p_owner_id, p_framework_id, unit_record.id,
    framework.catalog_release_id, framework.textbook_id, p_input->>'curriculumNodeId',
    next_period, next_sort, p_input->>'title', coalesce(p_input->>'mainActivity', ''),
    coalesce(p_input->>'observableProduct', ''), coalesce(p_input->>'assessmentEvidence', ''),
    coalesce(p_input->'anticipatedDifficulties', '[]'::jsonb),
    (p_input->>'plannedMinutes')::integer, coalesce(p_input->>'teacherNotes', '')
  );
  update public.semester_units
  set planned_periods = greatest(planned_periods, next_period),
      status = case when status = 'unplanned' then 'planned' else status end,
      version = version + 1, updated_at = now()
  where owner_id = p_owner_id and framework_id = p_framework_id and id = unit_record.id;
  update public.semester_frameworks set version = version + 1, updated_at = now()
  where owner_id = p_owner_id and id = p_framework_id returning * into framework;
  update public.framework_continuity_candidates set active = false, updated_at = now()
  where owner_id = p_owner_id and framework_id = p_framework_id and active;

  snapshot := public.semester_framework_snapshot(p_owner_id, p_framework_id);
  insert into public.semester_framework_versions(
    owner_id, framework_id, framework_version, snapshot, actor,
    idempotency_key, request_hash
  ) values (
    p_owner_id, p_framework_id, framework.version, snapshot, 'manual',
    p_idempotency_key, request_hash
  );
  return snapshot;
end;
$$;

create or replace function public.update_lesson_blueprint(
  p_owner_id uuid,
  p_framework_id uuid,
  p_blueprint_id uuid,
  p_input jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  framework public.semester_frameworks%rowtype;
  blueprint public.lesson_blueprints%rowtype;
  existing_version public.semester_framework_versions%rowtype;
  request_hash text;
  snapshot jsonb;
begin
  perform public.assert_service_scope(p_owner_id);
  request_hash := encode(extensions.digest(jsonb_build_object(
    'frameworkId', p_framework_id, 'blueprintId', p_blueprint_id, 'input', p_input
  )::text, 'sha256'), 'hex');
  select * into existing_version from public.semester_framework_versions version_record
  where version_record.owner_id = p_owner_id
    and version_record.idempotency_key = p_idempotency_key;
  if found then
    if existing_version.framework_id <> p_framework_id
      or existing_version.request_hash <> request_hash
    then raise exception 'idempotency_conflict'; end if;
    return existing_version.snapshot;
  end if;

  select * into framework from public.semester_frameworks candidate
  where candidate.owner_id = p_owner_id and candidate.id = p_framework_id for update;
  if not found then raise exception 'semester_framework_not_found'; end if;
  select * into blueprint from public.lesson_blueprints candidate
  where candidate.owner_id = p_owner_id and candidate.framework_id = p_framework_id
    and candidate.id = p_blueprint_id for update;
  if not found then raise exception 'lesson_blueprint_not_found'; end if;
  if blueprint.version <> (p_input->>'expectedVersion')::integer
  then raise exception 'stale_resource'; end if;

  update public.lesson_blueprints
  set title = case when p_input ? 'title' then p_input->>'title' else title end,
      main_activity = case when p_input ? 'mainActivity' then p_input->>'mainActivity' else main_activity end,
      observable_product = case when p_input ? 'observableProduct' then p_input->>'observableProduct' else observable_product end,
      assessment_evidence = case when p_input ? 'assessmentEvidence' then p_input->>'assessmentEvidence' else assessment_evidence end,
      anticipated_difficulties = case when p_input ? 'anticipatedDifficulties' then p_input->'anticipatedDifficulties' else anticipated_difficulties end,
      planned_minutes = case when p_input ? 'plannedMinutes' then (p_input->>'plannedMinutes')::integer else planned_minutes end,
      teacher_notes = case when p_input ? 'teacherNotes' then p_input->>'teacherNotes' else teacher_notes end,
      status = case when p_input ? 'status' then p_input->>'status' else status end,
      version = version + 1, updated_at = now()
  where owner_id = p_owner_id and framework_id = p_framework_id and id = p_blueprint_id;
  update public.semester_frameworks set version = version + 1, updated_at = now()
  where owner_id = p_owner_id and id = p_framework_id returning * into framework;

  snapshot := public.semester_framework_snapshot(p_owner_id, p_framework_id);
  insert into public.semester_framework_versions(
    owner_id, framework_id, framework_version, snapshot, actor,
    idempotency_key, request_hash
  ) values (
    p_owner_id, p_framework_id, framework.version, snapshot, 'manual',
    p_idempotency_key, request_hash
  );
  return snapshot;
end;
$$;

revoke all on function public.apply_manual_semester_framework_patch(uuid, uuid, jsonb, text),
  public.create_lesson_blueprint(uuid, uuid, uuid, jsonb, text),
  public.update_lesson_blueprint(uuid, uuid, uuid, jsonb, text)
from public, anon, authenticated;
grant execute on function public.apply_manual_semester_framework_patch(uuid, uuid, jsonb, text),
  public.create_lesson_blueprint(uuid, uuid, uuid, jsonb, text),
  public.update_lesson_blueprint(uuid, uuid, uuid, jsonb, text)
to service_role;
