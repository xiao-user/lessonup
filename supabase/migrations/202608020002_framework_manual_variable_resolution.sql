-- Recreate an already-installed 202608020001 function with the corrected
-- validation alias. Fresh databases already receive the corrected definition,
-- so this migration becomes a no-op there.
do $migration$
declare
  original_definition text;
  corrected_definition text;
  original_block text := $old$
    from public.semester_units unit_record
    join public.semester_frameworks candidate
      on candidate.owner_id = unit_record.owner_id and candidate.id = unit_record.framework_id
    where unit_record.owner_id = p_owner_id and unit_record.framework_id = p_framework_id
      and (
        (unit_record.planned_start_week is not null and unit_record.planned_start_week > candidate.total_weeks)
        or (unit_record.planned_end_week is not null and unit_record.planned_end_week > candidate.total_weeks)
        or (unit_record.planned_start_week is not null and unit_record.planned_end_week is not null
          and unit_record.planned_start_week > unit_record.planned_end_week)
      )
  $old$;
  corrected_block text := $new$
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
  $new$;
begin
  original_definition := pg_get_functiondef(
    'public.apply_manual_semester_framework_patch(uuid,uuid,jsonb,text)'::regprocedure
  );
  corrected_definition := replace(original_definition, original_block, corrected_block);
  if corrected_definition is distinct from original_definition then
    execute corrected_definition;
  end if;
end;
$migration$;
