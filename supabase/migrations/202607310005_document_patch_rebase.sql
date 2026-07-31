-- A document version orders snapshots and protects the final write, but it is
-- intentionally not the conflict boundary. Approval conflicts are decided at
-- the text operation level so unrelated teacher edits survive an Agent patch.
create or replace function public.apply_approved_document_patch(
  p_owner_id uuid,
  p_approval_id uuid,
  p_idempotency_key text
)
returns public.lesson_files
language plpgsql
security definer
set search_path = public
as $$
declare
  approval public.agent_approvals;
  current_file public.lesson_files;
  existing_version public.lesson_file_versions;
  operation jsonb;
  field_name text;
  source_text text;
  expected_text text;
  context_before text;
  context_after text;
  next_document jsonb;
  resolved_operations jsonb := '[]'::jsonb;
  resolved_start integer;
  resolved_end integer;
  search_from integer;
  relative_position integer;
  candidate_start integer;
  candidate_count integer;
begin
  perform public.assert_service_scope(p_owner_id);

  select * into approval
  from public.agent_approvals
  where owner_id = p_owner_id and id = p_approval_id
  for update;
  if not found then raise exception 'approval_not_found'; end if;

  select * into existing_version
  from public.lesson_file_versions
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if (
      existing_version.approval_id is not null
      and existing_version.approval_id <> p_approval_id
    ) or (
      existing_version.approval_id is null
      and (
        existing_version.idempotency_key <> ('approval:' || p_approval_id::text)
        or existing_version.lesson_file_id <> approval.patch->>'fileId'
        or existing_version.actor <> 'agent'
        or existing_version.run_id is distinct from approval.run_id
      )
    ) then
      raise exception 'idempotency_conflict';
    end if;
    update public.lesson_file_versions
    set approval_id = p_approval_id
    where id = existing_version.id and approval_id is null;
    select * into current_file
    from public.lesson_files
    where owner_id = p_owner_id and id = existing_version.lesson_file_id;
    return current_file;
  end if;

  if approval.state <> 'pending' then raise exception 'approval_not_approvable'; end if;
  select * into current_file
  from public.lesson_files
  where owner_id = p_owner_id and id = approval.patch->>'fileId'
  for update;
  if not found then raise exception 'lesson_file_not_found'; end if;

  -- Resolve every operation against one immutable view of the latest document
  -- before applying any of them. This prevents one replacement from shifting
  -- the target of another replacement in the same approval.
  for operation in
    select value
    from jsonb_array_elements(approval.patch->'operations')
  loop
    if operation->>'expectedText' = operation->>'replacement' then
      raise exception 'no_effect_patch';
    end if;

    field_name := operation->>'field';
    source_text := current_file.document->>field_name;
    expected_text := operation->>'expectedText';
    resolved_start := null;

    if current_file.document_version = (approval.patch->>'baseDocumentVersion')::integer then
      if substring(
        source_text
        from (operation->>'start')::integer + 1
        for char_length(expected_text)
      ) <> expected_text then
        raise exception 'text_mismatch';
      end if;
      resolved_start := (operation->>'start')::integer;
    elsif expected_text = '' then
      -- A stale insertion has no identity without a stable block anchor.
      raise exception 'stale_document';
    elsif substring(
      source_text
      from (operation->>'start')::integer + 1
      for char_length(expected_text)
    ) = expected_text then
      -- The target stayed at the same position; edits elsewhere are irrelevant.
      resolved_start := (operation->>'start')::integer;
    elsif operation ? 'contextBefore' or operation ? 'contextAfter' then
      context_before := operation->>'contextBefore';
      context_after := operation->>'contextAfter';
      search_from := 0;
      candidate_count := 0;

      loop
        relative_position := strpos(
          substring(source_text from search_from + 1),
          expected_text
        );
        exit when relative_position = 0;
        candidate_start := search_from + relative_position - 1;

        if (
          context_before is null
          or right(
            substring(source_text from 1 for candidate_start),
            char_length(context_before)
          ) = context_before
        ) and (
          context_after is null
          or substring(
            source_text
            from candidate_start + char_length(expected_text) + 1
            for char_length(context_after)
          ) = context_after
        ) then
          candidate_count := candidate_count + 1;
          resolved_start := candidate_start;
        end if;

        search_from := candidate_start + 1;
      end loop;

      if candidate_count <> 1 then raise exception 'stale_document'; end if;
    else
      raise exception 'stale_document';
    end if;

    resolved_end := resolved_start + char_length(expected_text);
    resolved_operations := resolved_operations || jsonb_build_array(
      operation || jsonb_build_object('start', resolved_start, 'end', resolved_end)
    );
  end loop;

  next_document := current_file.document;
  for operation in
    select value
    from jsonb_array_elements(resolved_operations)
    order by value->>'field', (value->>'start')::integer desc
  loop
    field_name := operation->>'field';
    source_text := next_document->>field_name;
    if substring(
      source_text
      from (operation->>'start')::integer + 1
      for (operation->>'end')::integer - (operation->>'start')::integer
    ) <> operation->>'expectedText' then
      raise exception 'text_mismatch';
    end if;
    source_text := substring(source_text from 1 for (operation->>'start')::integer)
      || (operation->>'replacement')
      || substring(source_text from (operation->>'end')::integer + 1);
    next_document := jsonb_set(next_document, array[field_name], to_jsonb(source_text), false);
  end loop;

  if next_document = current_file.document then raise exception 'no_effect_patch'; end if;

  current_file := public.save_lesson_document(
    p_owner_id,
    current_file.id,
    current_file.document_version,
    next_document,
    current_file.page_count,
    'agent',
    approval.run_id,
    p_idempotency_key
  );
  update public.lesson_file_versions
  set approval_id = p_approval_id
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  update public.agent_approvals set state = 'approved' where id = p_approval_id;
  return current_file;
end
$$;

revoke execute on function public.apply_approved_document_patch(uuid,uuid,text)
from public, anon, authenticated;
grant execute on function public.apply_approved_document_patch(uuid,uuid,text)
to service_role;
