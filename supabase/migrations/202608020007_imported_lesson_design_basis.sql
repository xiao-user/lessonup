-- Legacy/bootstrap imports are a second lesson-file creation path. Preserve
-- the invariant that every lesson file has one independent design basis,
-- including files imported after the original design-basis migration ran.

insert into public.lesson_design_bases(
  owner_id, notebook_id, lesson_file_id, learner_context
)
select file.owner_id, file.notebook_id, file.id, file.context_profile
from public.lesson_files file
where not exists (
  select 1 from public.lesson_design_bases basis
  where basis.owner_id = file.owner_id and basis.lesson_file_id = file.id
)
on conflict (owner_id, lesson_file_id) do nothing;

insert into public.lesson_design_basis_versions(
  owner_id, basis_id, basis_version, snapshot, actor, idempotency_key, request_hash
)
select basis.owner_id, basis.id, basis.version,
  public.lesson_design_basis_snapshot(basis.owner_id, basis.lesson_file_id),
  'import', 'design-basis:import:' || basis.id::text || ':' || basis.version::text,
  encode(extensions.digest(
    public.lesson_design_basis_snapshot(basis.owner_id, basis.lesson_file_id)::text,
    'sha256'
  ), 'hex')
from public.lesson_design_bases basis
where not exists (
  select 1 from public.lesson_design_basis_versions version_record
  where version_record.owner_id = basis.owner_id
    and version_record.basis_id = basis.id
    and version_record.basis_version = basis.version
)
on conflict do nothing;

create or replace function public.import_lessonup_notebooks(
  p_owner_id uuid,
  p_notebooks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  notebook jsonb;
  file jsonb;
  basis_id uuid;
  basis_version integer;
  basis_snapshot jsonb;
  imported integer := 0;
begin
  perform public.assert_service_scope(p_owner_id);
  for notebook in select * from jsonb_array_elements(p_notebooks) loop
    insert into public.notebooks(
      owner_id, id, title, class_name, year, subject, stage, grade, edition, tone
    )
    values (
      p_owner_id,
      notebook->>'id',
      notebook->>'title',
      notebook->>'className',
      notebook->>'year',
      notebook->>'subject',
      coalesce(notebook->>'stage', ''),
      coalesce(notebook->>'grade', ''),
      coalesce(notebook->>'edition', ''),
      coalesce(notebook->>'tone', 'teal')
    )
    on conflict (owner_id, id) do update set
      title = excluded.title,
      class_name = excluded.class_name,
      year = excluded.year,
      subject = excluded.subject,
      stage = excluded.stage,
      grade = excluded.grade,
      edition = excluded.edition,
      tone = excluded.tone,
      updated_at = now();
    for file in select * from jsonb_array_elements(coalesce(notebook->'files', '[]'::jsonb)) loop
      insert into public.lesson_files(owner_id, id, notebook_id, title, type, image, document, page_count)
      values (
        p_owner_id,
        file->>'id',
        notebook->>'id',
        file->>'title',
        coalesce(file->>'type', '教案'),
        file->>'image',
        file->'lessonPlan',
        coalesce((file->>'pages')::integer, 1)
      )
      on conflict (owner_id, id) do nothing;
      if found then
        imported := imported + 1;
        insert into public.lesson_file_versions(
          owner_id, lesson_file_id, document_version, document, page_count, actor, idempotency_key
        )
        values (
          p_owner_id,
          file->>'id',
          0,
          file->'lessonPlan',
          coalesce((file->>'pages')::integer, 1),
          'import',
          'import:' || (file->>'id')
        );
      end if;

      insert into public.lesson_design_bases(
        owner_id, notebook_id, lesson_file_id, learner_context
      )
      select stored.owner_id, stored.notebook_id, stored.id, stored.context_profile
      from public.lesson_files stored
      where stored.owner_id = p_owner_id and stored.id = file->>'id'
      on conflict (owner_id, lesson_file_id) do nothing;
      select basis.id, basis.version into basis_id, basis_version
      from public.lesson_design_bases basis
      where basis.owner_id = p_owner_id and basis.lesson_file_id = file->>'id';
      basis_snapshot := public.lesson_design_basis_snapshot(p_owner_id, file->>'id');
      insert into public.lesson_design_basis_versions(
        owner_id, basis_id, basis_version, snapshot, actor,
        idempotency_key, request_hash
      )
      values (
        p_owner_id, basis_id, basis_version, basis_snapshot, 'import',
        'design-basis:import:' || basis_id::text || ':' || basis_version::text,
        encode(extensions.digest(basis_snapshot::text, 'sha256'), 'hex')
      )
      on conflict do nothing;
    end loop;
  end loop;
  return jsonb_build_object('imported', imported);
end
$$;

revoke execute on function public.import_lessonup_notebooks(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.import_lessonup_notebooks(uuid, jsonb)
  to service_role;
