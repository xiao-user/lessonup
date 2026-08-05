-- PostgreSQL can bind the generic `||` operator before the JSON `->>` access
-- when the left literal has no explicit type. Parenthesize JSON extraction so
-- patch target keys are always text concatenations.

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

