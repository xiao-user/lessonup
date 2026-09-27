alter table public.classroom_presentation_generations
  add column if not exists storyboard jsonb;

alter table public.agent_approvals
  drop constraint agent_approvals_patch_kind_check,
  drop constraint agent_approvals_resource_shape_check;

alter table public.agent_approvals
  add constraint agent_approvals_patch_kind_check check (patch_kind in (
    'document', 'semester_framework', 'lesson_blueprint', 'lesson_design_basis',
    'presentation_storyboard'
  )),
  add constraint agent_approvals_resource_shape_check check (
    (resource_type = 'lesson_file'
      and patch_kind in ('document', 'presentation_storyboard')
      and lesson_file_id is not null
      and semester_framework_id is null
      and document_version is not null)
    or
    (resource_type = 'lesson_file'
      and patch_kind = 'lesson_design_basis'
      and lesson_file_id is not null
      and semester_framework_id is null
      and document_version is null)
    or
    (resource_type = 'semester_framework'
      and patch_kind in ('semester_framework', 'lesson_blueprint')
      and lesson_file_id is null
      and semester_framework_id is not null
      and document_version is null)
  );

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
    if p_approved and approval.patch_kind = 'presentation_storyboard' then
      select * into file from public.lesson_files
      where owner_id = p_owner_id and id = approval.lesson_file_id for update;
      if not found then raise exception 'lesson_file_not_found'; end if;
      if file.document_version <> approval.document_version
      then raise exception 'document_conflict'; end if;
      update public.agent_approvals set state = 'approved'
      where owner_id = p_owner_id and id = p_approval_id;
      file := null;
    elsif p_approved and approval.patch_kind = 'lesson_design_basis' then
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
  elsif p_approved and approval.patch_kind = 'presentation_storyboard' then
    file := null;
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

revoke execute on function public.decide_agent_approval(uuid,uuid,boolean,text)
from public, anon, authenticated;
grant execute on function public.decide_agent_approval(uuid,uuid,boolean,text)
to service_role;
