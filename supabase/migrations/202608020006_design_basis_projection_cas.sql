-- A design-basis projection writes the A4 document through the existing
-- document approval transaction. Before that transaction can mark the
-- approval approved, verify that every referenced teaching decision and the
-- optional learner-context snapshot are still current. Unrelated basis edits
-- are intentionally allowed.

create or replace function public.validate_design_basis_projection_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  projection jsonb;
  basis public.lesson_design_bases;
  basis_entry public.lesson_design_basis_entries;
  entry_ref jsonb;
  mapping jsonb;
  entry_id text;
  referenced_ids text[] := array[]::text[];
  mapped_ids text[] := array[]::text[];
  mapped_operations integer[] := array[]::integer[];
  operation_index integer;
  operation_count integer;
begin
  if new.state <> 'approved' or old.state <> 'pending' or not (new.patch ? 'projection') then
    return new;
  end if;
  if new.patch_kind <> 'document' or new.resource_type <> 'lesson_file'
    or new.lesson_file_id is null
  then raise exception 'approval_resource_scope_invalid'; end if;

  projection := new.patch->'projection';
  select * into basis from public.lesson_design_bases candidate
  where candidate.owner_id = new.owner_id
    and candidate.id = (projection->>'basisId')::uuid
    and candidate.lesson_file_id = new.lesson_file_id
  for share;
  if not found then raise exception 'stale_design_basis'; end if;

  for entry_ref in
    select value from jsonb_array_elements(coalesce(projection->'entryRefs', '[]'::jsonb))
  loop
    entry_id := entry_ref->>'entryId';
    if entry_id is null or entry_id = any(referenced_ids) then
      raise exception 'invalid_design_basis_projection';
    end if;
    referenced_ids := array_append(referenced_ids, entry_id);
    select * into basis_entry from public.lesson_design_basis_entries candidate
    where candidate.owner_id = new.owner_id
      and candidate.basis_id = basis.id
      and candidate.id = entry_id::uuid
    for share;
    if not found
      or basis_entry.version <> (entry_ref->>'expectedVersion')::integer
      or basis_entry.statement is distinct from entry_ref->>'expectedStatement'
      or basis_entry.decision <> 'accepted'
      or not basis_entry.teacher_confirmed
    then raise exception 'stale_design_basis'; end if;
  end loop;

  if projection ? 'expectedLearnerContext'
    and basis.learner_context is distinct from projection->'expectedLearnerContext'
  then raise exception 'stale_design_basis'; end if;

  operation_count := jsonb_array_length(coalesce(new.patch->'operations', '[]'::jsonb));
  for mapping in
    select value from jsonb_array_elements(coalesce(projection->'operationMappings', '[]'::jsonb))
  loop
    operation_index := (mapping->>'operationIndex')::integer;
    if operation_index < 0 or operation_index >= operation_count
      or operation_index = any(mapped_operations)
      or (
        jsonb_array_length(coalesce(mapping->'entryIds', '[]'::jsonb)) = 0
        and coalesce((mapping->>'usesLearnerContext')::boolean, false) = false
      )
    then raise exception 'invalid_design_basis_projection'; end if;
    mapped_operations := array_append(mapped_operations, operation_index);
    if coalesce((mapping->>'usesLearnerContext')::boolean, false)
      and not (projection ? 'expectedLearnerContext')
    then raise exception 'invalid_design_basis_projection'; end if;
    for entry_id in
      select jsonb_array_elements_text(coalesce(mapping->'entryIds', '[]'::jsonb))
    loop
      if not (entry_id = any(referenced_ids)) then
        raise exception 'invalid_design_basis_projection';
      end if;
      if not (entry_id = any(mapped_ids)) then
        mapped_ids := array_append(mapped_ids, entry_id);
      end if;
    end loop;
  end loop;
  if cardinality(mapped_operations) <> operation_count
    or cardinality(mapped_ids) <> cardinality(referenced_ids)
    or (cardinality(referenced_ids) = 0 and not (projection ? 'expectedLearnerContext'))
  then raise exception 'invalid_design_basis_projection'; end if;
  return new;
end;
$$;

drop trigger if exists validate_design_basis_projection_approval
  on public.agent_approvals;
create trigger validate_design_basis_projection_approval
before update of state on public.agent_approvals
for each row execute function public.validate_design_basis_projection_approval();

revoke execute on function public.validate_design_basis_projection_approval()
from public, anon, authenticated;
grant execute on function public.validate_design_basis_projection_approval()
to service_role;

