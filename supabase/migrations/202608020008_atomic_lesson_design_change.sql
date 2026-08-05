-- Teachers confirm one business change while the server preserves two
-- canonical resources. The design-basis patch and the A4 document patch are
-- applied in one database transaction; any conflict rolls both back.

create or replace function public.apply_approved_lesson_design_change(
  p_owner_id uuid,
  p_approval_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  approval public.agent_approvals;
  basis public.lesson_design_bases;
  file public.lesson_files;
  basis_snapshot jsonb;
  basis_idempotency_key text := p_idempotency_key || ':basis';
begin
  perform public.assert_service_scope(p_owner_id);
  select * into approval from public.agent_approvals candidate
  where candidate.owner_id = p_owner_id and candidate.id = p_approval_id
  for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.state <> 'pending' then raise exception 'approval_not_approvable'; end if;
  if approval.resource_type <> 'lesson_file'
    or approval.patch_kind <> 'document'
    or approval.lesson_file_id is null
    or not (approval.patch ? 'designBasisPatch')
    or not (approval.patch ? 'projection')
  then raise exception 'approval_resource_scope_invalid'; end if;

  select * into basis from public.lesson_design_bases candidate
  where candidate.owner_id = p_owner_id
    and candidate.lesson_file_id = approval.lesson_file_id
  for update;
  if not found
    or approval.patch->>'fileId' is distinct from approval.lesson_file_id
    or approval.patch->'designBasisPatch'->>'basisId' is distinct from basis.id::text
    or approval.patch->'designBasisPatch'->>'fileId' is distinct from approval.lesson_file_id
    or approval.patch->'projection'->>'basisId' is distinct from basis.id::text
  then raise exception 'approval_resource_scope_invalid'; end if;

  basis_snapshot := public.apply_lesson_design_basis_patch_internal(
    p_owner_id,
    basis.id,
    approval.patch->'designBasisPatch',
    'agent',
    approval.run_id,
    null,
    basis_idempotency_key
  );
  update public.lesson_design_basis_versions
  set approval_id = p_approval_id
  where owner_id = p_owner_id and idempotency_key = basis_idempotency_key;

  -- This marks the approval approved. The projection trigger therefore runs
  -- after the new/updated basis entries exist, but before the document write
  -- transaction can commit.
  file := public.apply_approved_document_patch(
    p_owner_id,
    p_approval_id,
    p_idempotency_key
  );
  return jsonb_build_object('file', to_jsonb(file), 'basis', basis_snapshot);
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
  basis jsonb;
  lesson_change jsonb;
  desired_state text;
begin
  perform public.assert_service_scope(p_owner_id);
  desired_state := case when p_approved then 'approved' else 'rejected' end;
  select * into approval from public.agent_approvals
  where owner_id = p_owner_id and id = p_approval_id for update;
  if not found then raise exception 'approval_not_found'; end if;
  if approval.expires_at <= now() or approval.state = 'expired'
  then raise exception 'approval_expired'; end if;
  if approval.state <> 'pending' and approval.state <> desired_state
  then raise exception 'approval_already_resolved'; end if;

  if approval.state = 'pending' then
    if p_approved and approval.patch_kind = 'lesson_design_basis' then
      basis := public.apply_approved_lesson_design_basis_patch(
        p_owner_id, p_approval_id, 'approval:' || p_approval_id::text
      );
    elsif p_approved and approval.resource_type = 'semester_framework' then
      framework := public.apply_approved_semester_framework_patch(
        p_owner_id, p_approval_id, 'approval:' || p_approval_id::text
      );
    elsif p_approved and approval.patch ? 'designBasisPatch' then
      lesson_change := public.apply_approved_lesson_design_change(
        p_owner_id, p_approval_id, 'approval:' || p_approval_id::text
      );
      file := jsonb_populate_record(null::public.lesson_files, lesson_change->'file');
      basis := lesson_change->'basis';
    elsif p_approved then
      file := public.apply_approved_document_patch(
        p_owner_id, p_approval_id, 'approval:' || p_approval_id::text
      );
    else
      update public.agent_approvals set state = 'rejected'
      where owner_id = p_owner_id and id = p_approval_id;
    end if;
  elsif p_approved and approval.patch_kind = 'lesson_design_basis' then
    basis := public.lesson_design_basis_snapshot(p_owner_id, approval.lesson_file_id);
  elsif p_approved and approval.resource_type = 'semester_framework' then
    framework := public.semester_framework_snapshot(p_owner_id, approval.semester_framework_id);
  elsif p_approved then
    select * into file from public.lesson_files
    where owner_id = p_owner_id and id = approval.lesson_file_id;
    if approval.patch ? 'designBasisPatch' then
      basis := public.lesson_design_basis_snapshot(p_owner_id, approval.lesson_file_id);
    end if;
  end if;

  update public.agent_approvals
  set encrypted_run_state = p_encrypted_run_state,
      continuation_status = case when continuation_status = 'completed' then 'completed' else 'ready' end,
      continuation_lease_token = null,
      continuation_lease_expires_at = null,
      continuation_error = null,
      continuation_message_id = coalesce(continuation_message_id, gen_random_uuid())
  where owner_id = p_owner_id and id = p_approval_id returning * into approval;

  return jsonb_build_object(
    'approval', to_jsonb(approval),
    'file', to_jsonb(file),
    'framework', framework,
    'basis', basis
  );
end;
$$;

revoke execute on function public.apply_approved_lesson_design_change(uuid,uuid,text),
  public.decide_agent_approval(uuid,uuid,boolean,text)
from public, anon, authenticated;
grant execute on function public.apply_approved_lesson_design_change(uuid,uuid,text),
  public.decide_agent_approval(uuid,uuid,boolean,text)
to service_role;
