create or replace function public.save_lesson_document(
  p_owner_id uuid,
  p_file_id text,
  p_base_version integer,
  p_document jsonb,
  p_page_count integer,
  p_source text,
  p_run_id uuid,
  p_idempotency_key text
)
returns public.lesson_files
language plpgsql
security definer
set search_path = public
as $$
declare
  current_file public.lesson_files;
  existing_version public.lesson_file_versions;
  request_hash text;
begin
  perform public.assert_service_scope(p_owner_id);
  request_hash := encode(extensions.digest(jsonb_build_object(
    'fileId', p_file_id,
    'baseVersion', p_base_version,
    'document', p_document,
    'pageCount', p_page_count,
    'source', p_source,
    'runId', p_run_id
  )::text, 'sha256'), 'hex');

  select *
  into existing_version
  from public.lesson_file_versions
  where owner_id = p_owner_id
    and idempotency_key = p_idempotency_key;

  if found then
    if (
      existing_version.request_hash is not null
      and existing_version.request_hash <> request_hash
    ) or (
      existing_version.request_hash is null
      and (
        existing_version.lesson_file_id <> p_file_id
        or existing_version.document <> p_document
        or existing_version.page_count <> p_page_count
        or existing_version.actor <> p_source
        or existing_version.run_id is distinct from p_run_id
      )
    )
    then
      raise exception 'idempotency_conflict';
    end if;
    select *
    into current_file
    from public.lesson_files
    where owner_id = p_owner_id and id = p_file_id;
    return current_file;
  end if;

  select *
  into current_file
  from public.lesson_files
  where owner_id = p_owner_id and id = p_file_id
  for update;
  if not found then raise exception 'lesson_file_not_found'; end if;
  if current_file.document_version <> p_base_version then raise exception 'stale_document'; end if;

  update public.lesson_files
  set
    document = p_document,
    document_version = document_version + 1,
    page_count = p_page_count,
    updated_at = now()
  where owner_id = p_owner_id and id = p_file_id
  returning * into current_file;

  insert into public.lesson_file_versions(
    owner_id,
    lesson_file_id,
    document_version,
    document,
    page_count,
    actor,
    run_id,
    idempotency_key,
    request_hash
  )
  values (
    p_owner_id,
    p_file_id,
    current_file.document_version,
    p_document,
    p_page_count,
    p_source,
    p_run_id,
    p_idempotency_key,
    request_hash
  );
  return current_file;
end
$$;

revoke execute on function public.save_lesson_document(
  uuid,text,integer,jsonb,integer,text,uuid,text
) from public, anon, authenticated;
grant execute on function public.save_lesson_document(
  uuid,text,integer,jsonb,integer,text,uuid,text
) to service_role;
