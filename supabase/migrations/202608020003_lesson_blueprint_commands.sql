-- Make lesson blueprints first-class, approval-gated framework commands.
-- Agent batches and manual CRUD share the same aggregate chronology.

create or replace function public.delete_lesson_blueprint(
  p_owner_id uuid,
  p_framework_id uuid,
  p_blueprint_id uuid,
  p_expected_version integer,
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
    'frameworkId', p_framework_id,
    'blueprintId', p_blueprint_id,
    'expectedVersion', p_expected_version
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
  if blueprint.version <> p_expected_version then raise exception 'stale_resource'; end if;

  delete from public.lesson_blueprints
  where owner_id = p_owner_id and framework_id = p_framework_id and id = p_blueprint_id;
  update public.semester_units
  set version = version + 1, updated_at = now()
  where owner_id = p_owner_id and framework_id = p_framework_id
    and id = blueprint.semester_unit_id;
  update public.semester_frameworks
  set version = version + 1, updated_at = now()
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

create or replace function public.apply_approved_semester_framework_patch(
  p_owner_id uuid,
  p_approval_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  approval public.agent_approvals%rowtype;
  framework public.semester_frameworks%rowtype;
  existing_version public.semester_framework_versions%rowtype;
  operation jsonb;
  unit_record public.semester_units%rowtype;
  blueprint public.lesson_blueprints%rowtype;
  current_value jsonb;
  replacement jsonb;
  field_name text;
  target_key text;
  seen_targets text[] := array[]::text[];
  modified_unit_ids uuid[] := array[]::uuid[];
  modified_blueprint_ids uuid[] := array[]::uuid[];
  snapshot jsonb;
  request_hash text;
begin
  perform public.assert_service_scope(p_owner_id);

  select * into existing_version from public.semester_framework_versions version_record
  where version_record.owner_id = p_owner_id
    and version_record.idempotency_key = p_idempotency_key;
  if found then
    if existing_version.approval_id is distinct from p_approval_id
    then raise exception 'idempotency_conflict'; end if;
    return existing_version.snapshot;
  end if;

  select * into approval from public.agent_approvals candidate
  where candidate.owner_id = p_owner_id and candidate.id = p_approval_id for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.resource_type <> 'semester_framework'
    or approval.patch_kind <> 'semester_framework'
    or approval.semester_framework_id is null
    or approval.patch->>'frameworkId' is distinct from approval.semester_framework_id::text
  then raise exception 'approval_resource_scope_invalid'; end if;
  if approval.state <> 'pending' then raise exception 'approval_not_approvable'; end if;

  select * into framework from public.semester_frameworks candidate
  where candidate.owner_id = p_owner_id and candidate.id = approval.semester_framework_id
  for update;
  if not found then raise exception 'semester_framework_not_found'; end if;

  for operation in
    select value from jsonb_array_elements(coalesce(approval.patch->'operations', '[]'::jsonb))
  loop
    field_name := operation->>'field';
    replacement := operation->'replacement';

    if operation->>'op' = 'replace_framework_field' then
      target_key := 'framework:' || field_name;
      current_value := case field_name
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
      if current_value is distinct from operation->'expectedValue' then raise exception 'stale_resource'; end if;
      if current_value = replacement then raise exception 'no_effect_patch'; end if;

      update public.semester_frameworks set
        title = case when field_name = 'title' then operation->>'replacement' else title end,
        term = case when field_name = 'term' then operation->>'replacement' else term end,
        start_date = case when field_name = 'startDate' then (operation->>'replacement')::date else start_date end,
        total_weeks = case when field_name = 'totalWeeks' then (operation->>'replacement')::integer else total_weeks end,
        weekly_periods = case when field_name = 'weeklyPeriods' then (operation->>'replacement')::integer else weekly_periods end,
        lesson_duration_minutes = case when field_name = 'lessonDurationMinutes' then (operation->>'replacement')::integer else lesson_duration_minutes end,
        capacity_ratio = case when field_name = 'capacityRatio' then (operation->>'replacement')::numeric else capacity_ratio end,
        planning_horizon_weeks = case when field_name = 'planningHorizonWeeks' then (operation->>'replacement')::integer else planning_horizon_weeks end,
        context_profile = case when field_name = 'contextProfile' then replacement else context_profile end,
        status = case when field_name = 'status' then operation->>'replacement' else status end
      where owner_id = p_owner_id and id = framework.id
      returning * into framework;

    elsif operation->>'op' = 'replace_unit_field' then
      target_key := 'unit:' || (operation->>'unitId') || ':' || field_name;
      select * into unit_record from public.semester_units candidate
      where candidate.owner_id = p_owner_id and candidate.framework_id = framework.id
        and candidate.id = (operation->>'unitId')::uuid for update;
      if not found then raise exception 'semester_unit_not_found'; end if;
      current_value := case field_name
        when 'plannedStartWeek' then coalesce(to_jsonb(unit_record.planned_start_week), 'null'::jsonb)
        when 'plannedEndWeek' then coalesce(to_jsonb(unit_record.planned_end_week), 'null'::jsonb)
        when 'plannedPeriods' then to_jsonb(unit_record.planned_periods)
        when 'learningGoals' then to_jsonb(unit_record.learning_goals)
        when 'teacherNotes' then to_jsonb(unit_record.teacher_notes)
        when 'status' then to_jsonb(unit_record.status)
        else null
      end;
      if current_value is null then raise exception 'invalid_framework_patch_field'; end if;
      if current_value is distinct from operation->'expectedValue' then raise exception 'stale_resource'; end if;
      if current_value = replacement then raise exception 'no_effect_patch'; end if;
      update public.semester_units set
        planned_start_week = case when field_name = 'plannedStartWeek' then (operation->>'replacement')::integer else planned_start_week end,
        planned_end_week = case when field_name = 'plannedEndWeek' then (operation->>'replacement')::integer else planned_end_week end,
        planned_periods = case when field_name = 'plannedPeriods' then (operation->>'replacement')::integer else planned_periods end,
        learning_goals = case when field_name = 'learningGoals' then operation->>'replacement' else learning_goals end,
        teacher_notes = case when field_name = 'teacherNotes' then operation->>'replacement' else teacher_notes end,
        status = case when field_name = 'status' then operation->>'replacement' else status end
      where owner_id = p_owner_id and framework_id = framework.id and id = unit_record.id;
      if not unit_record.id = any(modified_unit_ids) then
        modified_unit_ids := array_append(modified_unit_ids, unit_record.id);
      end if;

    elsif operation->>'op' = 'create_lesson_blueprint' then
      target_key := 'blueprint:create:' || (operation->>'blueprintId');
      select * into unit_record from public.semester_units candidate
      where candidate.owner_id = p_owner_id and candidate.framework_id = framework.id
        and candidate.id = (operation->>'semesterUnitId')::uuid for update;
      if not found then raise exception 'semester_unit_not_found'; end if;
      if exists (select 1 from public.lesson_blueprints candidate
        where candidate.owner_id = p_owner_id and candidate.id = (operation->>'blueprintId')::uuid)
      then raise exception 'duplicate_lesson_blueprint_id'; end if;
      if exists (select 1 from public.lesson_blueprints candidate
        where candidate.owner_id = p_owner_id and candidate.framework_id = framework.id
          and (
            (candidate.semester_unit_id = unit_record.id
              and candidate.planned_period = (operation->>'plannedPeriod')::integer)
            or candidate.sort_no = (operation->>'sortNo')::integer
          ))
      then raise exception 'stale_resource'; end if;
      if not exists (
        with recursive subtree as (
          select revision.node_id from public.curriculum_node_revisions revision
          where revision.catalog_release_id = framework.catalog_release_id
            and revision.textbook_id = framework.textbook_id
            and revision.node_id = unit_record.curriculum_node_id
          union all
          select child.node_id from public.curriculum_node_revisions child
          join subtree parent on child.parent_id = parent.node_id
          where child.catalog_release_id = framework.catalog_release_id
            and child.textbook_id = framework.textbook_id
        ) select 1 from subtree where node_id = operation->>'curriculumNodeId'
      ) then raise exception 'curriculum_node_outside_semester_unit'; end if;
      insert into public.lesson_blueprints(
        id, owner_id, framework_id, semester_unit_id, catalog_release_id, textbook_id,
        curriculum_node_id, planned_period, sort_no, title, main_activity,
        observable_product, assessment_evidence, anticipated_difficulties,
        planned_minutes, teacher_notes, status
      ) values (
        (operation->>'blueprintId')::uuid, p_owner_id, framework.id, unit_record.id,
        framework.catalog_release_id, framework.textbook_id, operation->>'curriculumNodeId',
        (operation->>'plannedPeriod')::integer, (operation->>'sortNo')::integer,
        operation->>'title', operation->>'mainActivity', operation->>'observableProduct',
        operation->>'assessmentEvidence', coalesce(operation->'anticipatedDifficulties', '[]'::jsonb),
        (operation->>'plannedMinutes')::integer, coalesce(operation->>'teacherNotes', ''),
        coalesce(operation->>'status', 'draft')
      );
      update public.semester_units set
        planned_periods = greatest(planned_periods, (operation->>'plannedPeriod')::integer),
        status = case when status = 'unplanned' then 'planned' else status end
      where owner_id = p_owner_id and framework_id = framework.id and id = unit_record.id;
      if not unit_record.id = any(modified_unit_ids) then
        modified_unit_ids := array_append(modified_unit_ids, unit_record.id);
      end if;

    elsif operation->>'op' = 'replace_lesson_blueprint_field' then
      target_key := 'blueprint:' || (operation->>'blueprintId') || ':' || field_name;
      select * into blueprint from public.lesson_blueprints candidate
      where candidate.owner_id = p_owner_id and candidate.framework_id = framework.id
        and candidate.id = (operation->>'blueprintId')::uuid for update;
      if not found then raise exception 'lesson_blueprint_not_found'; end if;
      current_value := case field_name
        when 'curriculumNodeId' then to_jsonb(blueprint.curriculum_node_id)
        when 'title' then to_jsonb(blueprint.title)
        when 'mainActivity' then to_jsonb(blueprint.main_activity)
        when 'observableProduct' then to_jsonb(blueprint.observable_product)
        when 'assessmentEvidence' then to_jsonb(blueprint.assessment_evidence)
        when 'anticipatedDifficulties' then blueprint.anticipated_difficulties
        when 'plannedMinutes' then coalesce(to_jsonb(blueprint.planned_minutes), 'null'::jsonb)
        when 'teacherNotes' then to_jsonb(blueprint.teacher_notes)
        when 'status' then to_jsonb(blueprint.status)
        else null
      end;
      if current_value is null then raise exception 'invalid_framework_patch_field'; end if;
      if current_value is distinct from operation->'expectedValue' then raise exception 'stale_resource'; end if;
      if current_value = replacement then raise exception 'no_effect_patch'; end if;
      if field_name = 'curriculumNodeId' and not exists (
        with recursive subtree as (
          select revision.node_id from public.curriculum_node_revisions revision
          where revision.catalog_release_id = framework.catalog_release_id
            and revision.textbook_id = framework.textbook_id
            and revision.node_id = (select curriculum_node_id from public.semester_units
              where owner_id = p_owner_id and framework_id = framework.id
                and id = blueprint.semester_unit_id)
          union all
          select child.node_id from public.curriculum_node_revisions child
          join subtree parent on child.parent_id = parent.node_id
          where child.catalog_release_id = framework.catalog_release_id
            and child.textbook_id = framework.textbook_id
        ) select 1 from subtree where node_id = operation->>'replacement'
      ) then raise exception 'curriculum_node_outside_semester_unit'; end if;
      update public.lesson_blueprints set
        curriculum_node_id = case when field_name = 'curriculumNodeId' then operation->>'replacement' else curriculum_node_id end,
        title = case when field_name = 'title' then operation->>'replacement' else title end,
        main_activity = case when field_name = 'mainActivity' then operation->>'replacement' else main_activity end,
        observable_product = case when field_name = 'observableProduct' then operation->>'replacement' else observable_product end,
        assessment_evidence = case when field_name = 'assessmentEvidence' then operation->>'replacement' else assessment_evidence end,
        anticipated_difficulties = case when field_name = 'anticipatedDifficulties' then replacement else anticipated_difficulties end,
        planned_minutes = case when field_name = 'plannedMinutes' then (operation->>'replacement')::integer else planned_minutes end,
        teacher_notes = case when field_name = 'teacherNotes' then operation->>'replacement' else teacher_notes end,
        status = case when field_name = 'status' then operation->>'replacement' else status end
      where owner_id = p_owner_id and framework_id = framework.id and id = blueprint.id;
      if not blueprint.id = any(modified_blueprint_ids) then
        modified_blueprint_ids := array_append(modified_blueprint_ids, blueprint.id);
      end if;

    elsif operation->>'op' = 'delete_lesson_blueprint' then
      target_key := 'blueprint:delete:' || (operation->>'blueprintId');
      select * into blueprint from public.lesson_blueprints candidate
      where candidate.owner_id = p_owner_id and candidate.framework_id = framework.id
        and candidate.id = (operation->>'blueprintId')::uuid for update;
      if not found then raise exception 'lesson_blueprint_not_found'; end if;
      if blueprint.version <> (operation->>'expectedVersion')::integer then raise exception 'stale_resource'; end if;
      delete from public.lesson_blueprints
      where owner_id = p_owner_id and framework_id = framework.id and id = blueprint.id;
      if not blueprint.semester_unit_id = any(modified_unit_ids) then
        modified_unit_ids := array_append(modified_unit_ids, blueprint.semester_unit_id);
      end if;
    else
      raise exception 'invalid_framework_patch_operation';
    end if;

    if target_key = any(seen_targets) then raise exception 'duplicate_framework_patch_target'; end if;
    seen_targets := array_append(seen_targets, target_key);
  end loop;

  if cardinality(seen_targets) = 0 then raise exception 'empty_patch'; end if;
  select * into framework from public.semester_frameworks candidate
  where candidate.owner_id = p_owner_id and candidate.id = framework.id;
  if framework.planning_horizon_weeks > framework.total_weeks then
    raise exception 'planning_horizon_exceeds_term';
  end if;
  if jsonb_typeof(framework.context_profile) <> 'object' then
    raise exception 'invalid_framework_patch_value';
  end if;
  if exists (
    select 1 from public.semester_units candidate
    where candidate.owner_id = p_owner_id and candidate.framework_id = framework.id
      and (
        candidate.planned_start_week > framework.total_weeks
        or candidate.planned_end_week > framework.total_weeks
        or candidate.planned_start_week > candidate.planned_end_week
      )
  ) then raise exception 'semester_unit_week_range_invalid'; end if;

  update public.semester_units set version = version + 1, updated_at = now()
  where owner_id = p_owner_id and framework_id = framework.id and id = any(modified_unit_ids);
  update public.lesson_blueprints set version = version + 1, updated_at = now()
  where owner_id = p_owner_id and framework_id = framework.id and id = any(modified_blueprint_ids);
  update public.semester_frameworks set version = version + 1, updated_at = now()
  where owner_id = p_owner_id and id = framework.id returning * into framework;
  update public.framework_continuity_candidates set active = false, updated_at = now()
  where owner_id = p_owner_id and framework_id = framework.id and active;
  update public.agent_approvals set state = 'approved'
  where owner_id = p_owner_id and id = p_approval_id;

  snapshot := public.semester_framework_snapshot(p_owner_id, framework.id);
  request_hash := encode(extensions.digest(approval.patch::text, 'sha256'), 'hex');
  insert into public.semester_framework_versions(
    owner_id, framework_id, framework_version, snapshot, actor, run_id,
    approval_id, idempotency_key, request_hash
  ) values (
    p_owner_id, framework.id, framework.version, snapshot, 'agent', approval.run_id,
    p_approval_id, p_idempotency_key, request_hash
  );
  return snapshot;
end;
$$;

revoke all on function public.delete_lesson_blueprint(uuid, uuid, uuid, integer, text),
  public.apply_approved_semester_framework_patch(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.delete_lesson_blueprint(uuid, uuid, uuid, integer, text),
  public.apply_approved_semester_framework_patch(uuid, uuid, text)
to service_role;
