-- The first presentation prototype used a job/revision queue. The production
-- path is deliberately smaller: one canonical outline and one self-contained
-- HTML artifact, generated synchronously by the Agent Function Tool.
create table if not exists public.classroom_presentation_documents (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  notebook_id text not null,
  lesson_file_id text not null,
  title text not null,
  theme text not null,
  source_document_version integer not null,
  source_document jsonb not null,
  outline jsonb not null,
  storage_key text not null,
  media_type text not null,
  byte_size integer not null,
  checksum text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, idempotency_key),
  foreign key (owner_id, notebook_id)
    references public.notebooks(owner_id, id) on delete cascade,
  foreign key (owner_id, lesson_file_id)
    references public.lesson_files(owner_id, id) on delete cascade
);

create index if not exists classroom_presentation_documents_lesson_file_idx
  on public.classroom_presentation_documents (owner_id, lesson_file_id, updated_at desc);

alter table public.classroom_presentation_documents enable row level security;
drop policy if exists classroom_presentation_documents_owner on public.classroom_presentation_documents;
create policy classroom_presentation_documents_owner
  on public.classroom_presentation_documents
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

revoke all on table public.classroom_presentation_documents from anon, authenticated;
grant select, insert, update, delete on table public.classroom_presentation_documents to service_role;
