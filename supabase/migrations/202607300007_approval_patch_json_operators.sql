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
  next_document jsonb;
begin
  perform public.assert_service_scope(p_owner_id);

  select *
  into approval
  from public.agent_approvals
  where owner_id = p_owner_id and id = p_approval_id
  for update;
  if not found then raise exception 'approval_not_found'; end if;

  select *
  into existing_version
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
    )
    then
      raise exception 'idempotency_conflict';
    end if;
    update public.lesson_file_versions
    set approval_id = p_approval_id
    where id = existing_version.id and approval_id is null;
    select *
    into current_file
    from public.lesson_files
    where owner_id = p_owner_id and id = existing_version.lesson_file_id;
    return current_file;
  end if;

  if approval.state <> 'pending' then raise exception 'approval_not_approvable'; end if;
  select *
  into current_file
  from public.lesson_files
  where owner_id = p_owner_id and id = approval.patch->>'fileId'
  for update;
  if not found then raise exception 'lesson_file_not_found'; end if;
  if current_file.document_version <> (approval.patch->>'baseDocumentVersion')::integer then
    raise exception 'stale_document';
  end if;

  next_document := current_file.document;
  for operation in
    select value
    from jsonb_array_elements(approval.patch->'operations')
    order by value->>'field', (value->>'start')::integer desc
  loop
    field_name := operation->>'field';
    source_text := next_document->>field_name;
    if substring(
      source_text
      from (operation->>'start')::integer + 1
      for (operation->>'end')::integer - (operation->>'start')::integer
    ) <> operation->>'expectedText'
    then
      raise exception 'text_mismatch';
    end if;
    source_text := substring(source_text from 1 for (operation->>'start')::integer)
      || (operation->>'replacement')
      || substring(source_text from (operation->>'end')::integer + 1);
    next_document := jsonb_set(next_document, array[field_name], to_jsonb(source_text), false);
  end loop;

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
  desired_state text;
begin
  perform public.assert_service_scope(p_owner_id);
  desired_state := case when p_approved then 'approved' else 'rejected' end;

  select *
  into approval
  from public.agent_approvals
  where owner_id = p_owner_id and id = p_approval_id
  for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.expires_at <= now() or approval.state = 'expired' then raise exception 'approval_expired'; end if;
  if approval.state <> 'pending' and approval.state <> desired_state then
    raise exception 'approval_already_resolved';
  end if;

  if approval.state = 'pending' then
    if p_approved then
      file := public.apply_approved_document_patch(
        p_owner_id,
        p_approval_id,
        'approval:' || p_approval_id::text
      );
    else
      update public.agent_approvals
      set state = 'rejected'
      where owner_id = p_owner_id and id = p_approval_id;
    end if;
  elsif p_approved then
    select *
    into file
    from public.lesson_files
    where owner_id = p_owner_id and id = approval.patch->>'fileId';
  end if;

  update public.agent_approvals
  set
    encrypted_run_state = p_encrypted_run_state,
    continuation_status = case
      when continuation_status = 'completed' then 'completed'
      else 'ready'
    end,
    continuation_lease_token = null,
    continuation_lease_expires_at = null,
    continuation_error = null,
    continuation_message_id = coalesce(continuation_message_id, gen_random_uuid())
  where owner_id = p_owner_id and id = p_approval_id
  returning * into approval;

  return jsonb_build_object('approval', to_jsonb(approval), 'file', to_jsonb(file));
end
$$;

revoke execute on function public.apply_approved_document_patch(uuid,uuid,text)
from public, anon, authenticated;
revoke execute on function public.decide_agent_approval(uuid,uuid,boolean,text)
from public, anon, authenticated;
grant execute on function public.apply_approved_document_patch(uuid,uuid,text)
to service_role;
grant execute on function public.decide_agent_approval(uuid,uuid,boolean,text)
to service_role;
