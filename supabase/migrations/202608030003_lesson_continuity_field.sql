update public.lesson_files
set document = jsonb_set(document, '{continuity}', '""'::jsonb, true)
where not (document ? 'continuity');

update public.lesson_file_versions
set document = jsonb_set(document, '{continuity}', '""'::jsonb, true)
where not (document ? 'continuity');
