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
  if current_file.document_version <> (approval.patch->>'baseDocumentVersion')::integer then
    raise exception 'stale_document';
  end if;

  next_document := current_file.document;
  for operation in
    select value
    from jsonb_array_elements(approval.patch->'operations')
    order by value->>'field', (value->>'start')::integer desc
  loop
    if operation->>'expectedText' = operation->>'replacement' then
      raise exception 'no_effect_patch';
    end if;
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

  if next_document = current_file.document then
    raise exception 'no_effect_patch';
  end if;

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

create or replace function public.set_expired_approval_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state = 'expired' and old.state is distinct from 'expired' then
    update public.agent_runs
    set status = 'failed', error = 'approval_expired', completed_at = coalesce(completed_at, now())
    where owner_id = new.owner_id
      and id = new.run_id
      and status not in ('completed', 'cancelled');

    update public.agent_threads
    set status = 'failed', updated_at = now()
    where owner_id = new.owner_id
      and id = new.thread_id
      and status in ('running', 'awaiting_approval');
  end if;
  return new;
end
$$;

drop trigger if exists agent_approval_expiry_lifecycle on public.agent_approvals;
create trigger agent_approval_expiry_lifecycle
after update of state on public.agent_approvals
for each row
execute function public.set_expired_approval_lifecycle();

create or replace function public.expire_agent_approval_lifecycle(
  p_owner_id uuid,
  p_approval_id uuid
)
returns public.agent_approvals
language plpgsql
security definer
set search_path = public
as $$
declare
  approval public.agent_approvals;
begin
  perform public.assert_service_scope(p_owner_id);
  update public.agent_approvals
  set state = 'expired', continuation_error = 'approval_expired'
  where owner_id = p_owner_id
    and id = p_approval_id
    and state = 'pending'
  returning * into approval;

  if not found then
    select * into approval
    from public.agent_approvals
    where owner_id = p_owner_id and id = p_approval_id;
    if not found then raise exception 'approval_not_found'; end if;
  end if;
  return approval;
end
$$;

revoke execute on function public.apply_approved_document_patch(uuid,uuid,text)
from public, anon, authenticated;
revoke execute on function public.set_expired_approval_lifecycle()
from public, anon, authenticated;
revoke execute on function public.expire_agent_approval_lifecycle(uuid,uuid)
from public, anon, authenticated;
grant execute on function public.apply_approved_document_patch(uuid,uuid,text)
to service_role;
grant execute on function public.expire_agent_approval_lifecycle(uuid,uuid)
to service_role;
