alter table public.agent_threads
  add column if not exists starter_suggestions jsonb not null default '[]'::jsonb,
  add column if not exists starter_suggestions_document_version integer;

alter table public.agent_threads
  drop constraint if exists agent_threads_starter_suggestions_array;

alter table public.agent_threads
  add constraint agent_threads_starter_suggestions_array
  check (jsonb_typeof(starter_suggestions) = 'array');
