alter table public.lesson_files
  add column if not exists context_profile jsonb not null default '{}'::jsonb;

alter table public.lesson_files
  drop constraint if exists lesson_files_context_profile_shape;

alter table public.lesson_files
  add constraint lesson_files_context_profile_shape check (
    jsonb_typeof(context_profile) = 'object'
    and (
      not (context_profile ? 'lessonDurationMinutes')
      or (
        jsonb_typeof(context_profile->'lessonDurationMinutes') = 'number'
        and (context_profile->>'lessonDurationMinutes')::integer between 10 and 180
      )
    )
  );
