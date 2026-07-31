-- Notebook-level curriculum scope: stage → grade → subject → edition.
-- Lesson-level unit binding remains in lesson_files.context_profile.curriculum.

alter table public.notebooks
  add column if not exists stage text not null default '',
  add column if not exists grade text not null default '',
  add column if not exists edition text not null default '';

create index if not exists notebooks_curriculum_idx
  on public.notebooks (owner_id, stage, grade, subject, edition);

create or replace function public.import_lessonup_notebooks(
  p_owner_id uuid,
  p_notebooks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  notebook jsonb;
  file jsonb;
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
    end loop;
  end loop;
  return jsonb_build_object('imported', imported);
end
$$;

revoke execute on function public.import_lessonup_notebooks(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.import_lessonup_notebooks(uuid, jsonb)
  to service_role;
