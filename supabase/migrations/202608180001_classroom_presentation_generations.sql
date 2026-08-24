-- A Dashi render can outlive the browser request that started it. Keep one
-- small durable status record per in-flight lesson so A4 and Agent entry
-- points observe the exact same state after refresh.
create table if not exists public.classroom_presentation_generations (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  notebook_id text not null,
  lesson_file_id text not null,
  source_document_version integer not null,
  source_document jsonb not null,
  lesson_title text not null,
  subject text not null,
  grade_level text not null default '',
  learner_profile text not null default '',
  lesson_duration_minutes integer not null default 40,
  direction text,
  status text not null check (status in ('generating', 'ready', 'failed')),
  presentation_id uuid references public.classroom_presentation_documents(id) on delete set null,
  error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  foreign key (owner_id, notebook_id)
    references public.notebooks(owner_id, id) on delete cascade,
  foreign key (owner_id, lesson_file_id)
    references public.lesson_files(owner_id, id) on delete cascade
);

create unique index if not exists classroom_presentation_generations_one_active_per_lesson
  on public.classroom_presentation_generations (owner_id, lesson_file_id)
  where status = 'generating';

create index if not exists classroom_presentation_generations_latest_idx
  on public.classroom_presentation_generations (owner_id, lesson_file_id, started_at desc);

alter table public.classroom_presentation_generations enable row level security;
drop policy if exists classroom_presentation_generations_owner on public.classroom_presentation_generations;
create policy classroom_presentation_generations_owner
  on public.classroom_presentation_generations
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

revoke all on table public.classroom_presentation_generations from anon, authenticated;
grant select, insert, update, delete on table public.classroom_presentation_generations to service_role;
