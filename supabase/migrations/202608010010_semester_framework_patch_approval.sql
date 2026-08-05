-- Recoverable, idempotent ResourcePatch application for semester frameworks.

alter table public.semester_framework_versions
  add constraint semester_framework_versions_approval_fkey
  foreign key (approval_id) references public.agent_approvals(id) on delete set null;

create unique index semester_framework_versions_approval_unique_idx
  on public.semester_framework_versions(owner_id, approval_id)
  where approval_id is not null;

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
  unit_entry record;
  unit_state jsonb;
  unit_updates jsonb := '{}'::jsonb;
  seen_targets text[] := array[]::text[];
  target_key text;
  current_value jsonb;
  replacement jsonb;
  next_title text;
  next_term text;
  next_start_date date;
  next_total_weeks integer;
  next_weekly_periods integer;
  next_lesson_duration integer;
  next_capacity_ratio numeric;
  next_planning_horizon integer;
  next_context_profile jsonb;
  next_status text;
  snapshot jsonb;
  request_hash text;
begin
  perform public.assert_service_scope(p_owner_id);

  select * into existing_version
  from public.semester_framework_versions version_record
  where version_record.owner_id = p_owner_id
    and version_record.idempotency_key = p_idempotency_key;
  if found then
    if existing_version.approval_id is distinct from p_approval_id then
      raise exception 'idempotency_conflict';
    end if;
    return existing_version.snapshot;
  end if;

  select * into approval
  from public.agent_approvals approval_record
  where approval_record.owner_id = p_owner_id and approval_record.id = p_approval_id
  for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.resource_type <> 'semester_framework'
    or approval.patch_kind <> 'semester_framework'
    or approval.semester_framework_id is null
    or approval.patch->>'frameworkId' is distinct from approval.semester_framework_id::text
  then
    raise exception 'approval_resource_scope_invalid';
  end if;
  if approval.state <> 'pending' then raise exception 'approval_not_approvable'; end if;

  select * into framework
  from public.semester_frameworks framework_record
  where framework_record.owner_id = p_owner_id
    and framework_record.id = approval.semester_framework_id
  for update;
  if not found then raise exception 'semester_framework_not_found'; end if;

  next_title := framework.title;
  next_term := framework.term;
  next_start_date := framework.start_date;
  next_total_weeks := framework.total_weeks;
  next_weekly_periods := framework.weekly_periods;
  next_lesson_duration := framework.lesson_duration_minutes;
  next_capacity_ratio := framework.capacity_ratio;
  next_planning_horizon := framework.planning_horizon_weeks;
  next_context_profile := framework.context_profile;
  next_status := framework.status;

  for operation in
    select value from jsonb_array_elements(coalesce(approval.patch->'operations', '[]'::jsonb))
  loop
    if operation->>'op' = 'replace_framework_field' then
      target_key := 'framework:' || (operation->>'field');
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
      replacement := operation->'replacement';
      if current_value is distinct from operation->'expectedValue' then
        raise exception 'stale_resource';
      end if;
      if current_value = replacement then raise exception 'no_effect_patch'; end if;

      case operation->>'field'
        when 'title' then next_title := operation->>'replacement';
        when 'term' then next_term := operation->>'replacement';
        when 'startDate' then next_start_date := (operation->>'replacement')::date;
        when 'totalWeeks' then next_total_weeks := (operation->>'replacement')::integer;
        when 'weeklyPeriods' then next_weekly_periods := (operation->>'replacement')::integer;
        when 'lessonDurationMinutes' then next_lesson_duration := (operation->>'replacement')::integer;
        when 'capacityRatio' then next_capacity_ratio := (operation->>'replacement')::numeric;
        when 'planningHorizonWeeks' then next_planning_horizon := (operation->>'replacement')::integer;
        when 'contextProfile' then next_context_profile := replacement;
        when 'status' then next_status := operation->>'replacement';
      end case;
    elsif operation->>'op' = 'replace_unit_field' then
      target_key := 'unit:' || (operation->>'unitId') || ':' || (operation->>'field');
      select * into unit_record
      from public.semester_units candidate
      where candidate.owner_id = p_owner_id
        and candidate.framework_id = framework.id
        and candidate.id = (operation->>'unitId')::uuid;
      if not found then raise exception 'semester_unit_not_found'; end if;

      unit_state := coalesce(unit_updates->(unit_record.id::text), jsonb_build_object(
        'plannedStartWeek', unit_record.planned_start_week,
        'plannedEndWeek', unit_record.planned_end_week,
        'plannedPeriods', unit_record.planned_periods,
        'learningGoals', unit_record.learning_goals,
        'teacherNotes', unit_record.teacher_notes,
        'status', unit_record.status
      ));
      current_value := unit_state->(operation->>'field');
      if current_value is null then raise exception 'invalid_framework_patch_field'; end if;
      replacement := operation->'replacement';
      if current_value is distinct from operation->'expectedValue' then
        raise exception 'stale_resource';
      end if;
      if current_value = replacement then raise exception 'no_effect_patch'; end if;
      unit_state := jsonb_set(unit_state, array[operation->>'field'], replacement, false);
      unit_updates := jsonb_set(unit_updates, array[unit_record.id::text], unit_state, true);
    else
      raise exception 'invalid_framework_patch_operation';
    end if;

    if target_key = any(seen_targets) then
      raise exception 'duplicate_framework_patch_target';
    end if;
    seen_targets := array_append(seen_targets, target_key);
  end loop;

  if cardinality(seen_targets) = 0 then raise exception 'empty_patch'; end if;
  if next_planning_horizon > next_total_weeks then
    raise exception 'planning_horizon_exceeds_term';
  end if;
  if jsonb_typeof(next_context_profile) <> 'object' then
    raise exception 'invalid_framework_patch_value';
  end if;

  -- Validate every unit against the new term length, including units that were
  -- not touched by this patch.
  for unit_record in
    select * from public.semester_units candidate
    where candidate.owner_id = p_owner_id and candidate.framework_id = framework.id
    for update
  loop
    unit_state := coalesce(unit_updates->(unit_record.id::text), jsonb_build_object(
      'plannedStartWeek', unit_record.planned_start_week,
      'plannedEndWeek', unit_record.planned_end_week,
      'plannedPeriods', unit_record.planned_periods,
      'learningGoals', unit_record.learning_goals,
      'teacherNotes', unit_record.teacher_notes,
      'status', unit_record.status
    ));
    if (unit_state->>'plannedStartWeek')::integer > next_total_weeks
      or (unit_state->>'plannedEndWeek')::integer > next_total_weeks
    then
      raise exception 'semester_unit_week_exceeds_term';
    end if;
    if (unit_state->>'plannedStartWeek')::integer
      > (unit_state->>'plannedEndWeek')::integer
    then
      raise exception 'semester_unit_week_range_invalid';
    end if;
  end loop;

  update public.semester_frameworks
  set title = next_title,
      term = next_term,
      start_date = next_start_date,
      total_weeks = next_total_weeks,
      weekly_periods = next_weekly_periods,
      lesson_duration_minutes = next_lesson_duration,
      capacity_ratio = next_capacity_ratio,
      planning_horizon_weeks = next_planning_horizon,
      context_profile = next_context_profile,
      status = next_status,
      version = version + 1,
      updated_at = now()
  where owner_id = p_owner_id and id = framework.id;

  for unit_entry in select key, value from jsonb_each(unit_updates)
  loop
    update public.semester_units
    set planned_start_week = (unit_entry.value->>'plannedStartWeek')::integer,
        planned_end_week = (unit_entry.value->>'plannedEndWeek')::integer,
        planned_periods = (unit_entry.value->>'plannedPeriods')::integer,
        learning_goals = unit_entry.value->>'learningGoals',
        teacher_notes = unit_entry.value->>'teacherNotes',
        status = unit_entry.value->>'status',
        version = version + 1,
        updated_at = now()
    where owner_id = p_owner_id
      and framework_id = framework.id
      and id = unit_entry.key::uuid;
  end loop;

  update public.agent_approvals
  set state = 'approved'
  where owner_id = p_owner_id and id = p_approval_id;

  snapshot := public.semester_framework_snapshot(p_owner_id, framework.id);
  request_hash := encode(extensions.digest(approval.patch::text, 'sha256'), 'hex');
  insert into public.semester_framework_versions(
    owner_id, framework_id, framework_version, snapshot, actor, run_id,
    approval_id, idempotency_key, request_hash
  ) values (
    p_owner_id, framework.id, framework.version + 1, snapshot, 'agent',
    approval.run_id, p_approval_id, p_idempotency_key, request_hash
  );

  return snapshot;
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
  desired_state text;
begin
  perform public.assert_service_scope(p_owner_id);
  desired_state := case when p_approved then 'approved' else 'rejected' end;

  select * into approval
  from public.agent_approvals
  where owner_id = p_owner_id and id = p_approval_id
  for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.expires_at <= now() or approval.state = 'expired' then
    raise exception 'approval_expired';
  end if;
  if approval.state <> 'pending' and approval.state <> desired_state then
    raise exception 'approval_already_resolved';
  end if;

  if approval.state = 'pending' then
    if p_approved and approval.resource_type = 'semester_framework' then
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
  elsif p_approved and approval.resource_type = 'semester_framework' then
    framework := public.semester_framework_snapshot(
      p_owner_id, approval.semester_framework_id
    );
  elsif p_approved then
    select * into file from public.lesson_files
    where owner_id = p_owner_id and id = approval.lesson_file_id;
  end if;

  update public.agent_approvals
  set encrypted_run_state = p_encrypted_run_state,
      continuation_status = case
        when continuation_status = 'completed' then 'completed' else 'ready'
      end,
      continuation_lease_token = null,
      continuation_lease_expires_at = null,
      continuation_error = null,
      continuation_message_id = coalesce(continuation_message_id, gen_random_uuid())
  where owner_id = p_owner_id and id = p_approval_id
  returning * into approval;

  return jsonb_build_object(
    'approval', to_jsonb(approval),
    'file', to_jsonb(file),
    'framework', framework
  );
end;
$$;

revoke all on function public.apply_approved_semester_framework_patch(uuid, uuid, text),
  public.decide_agent_approval(uuid, uuid, boolean, text)
from public, anon, authenticated;
grant execute on function public.apply_approved_semester_framework_patch(uuid, uuid, text),
  public.decide_agent_approval(uuid, uuid, boolean, text)
to service_role;
