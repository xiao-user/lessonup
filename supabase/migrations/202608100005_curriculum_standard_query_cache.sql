create table if not exists public.curriculum_standard_query_cache (
  context_fingerprint text not null,
  query_sha256 text not null check (query_sha256 ~ '^[0-9a-f]{64}$'),
  result_limit smallint not null check (result_limit between 1 and 8),
  results jsonb not null check (jsonb_typeof(results) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (context_fingerprint, query_sha256, result_limit)
);

create index if not exists curriculum_standard_query_cache_updated
  on public.curriculum_standard_query_cache(updated_at);

alter table public.curriculum_standard_query_cache enable row level security;
revoke all on public.curriculum_standard_query_cache from public, anon, authenticated;
grant select, insert, update, delete on public.curriculum_standard_query_cache to service_role;

alter table public.agent_run_evidence
  drop constraint if exists agent_run_evidence_kind_check;
alter table public.agent_run_evidence
  add constraint agent_run_evidence_kind_check check (
    kind in (
      'knowledge_search', 'knowledge_passage', 'attachment_read',
      'source_metadata', 'web_search', 'web_open',
      'curriculum_textbook', 'curriculum_outline', 'curriculum_semantics',
      'curriculum_knowledge', 'curriculum_standard_search'
    )
  );

