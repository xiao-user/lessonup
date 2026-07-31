-- Platform-level Chinese textbook catalog (SmartEdu official directory trees).
-- No owner_id: readable by service_role only; never exposed directly to anon/authenticated.

create table if not exists public.curriculum_textbooks (
  id text primary key,
  title text not null,
  stage text not null,
  subject text not null,
  edition text not null,
  grade text not null,
  volume text not null default '',
  publisher text not null default '',
  ebook_id text,
  node_count integer not null default 0 check (node_count >= 0),
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.curriculum_nodes (
  textbook_id text not null references public.curriculum_textbooks(id) on delete cascade,
  node_id text not null,
  parent_id text,
  level integer not null check (level between 1 and 8),
  sort_no integer not null,
  title text not null,
  page_number integer,
  primary key (textbook_id, node_id)
);

create index if not exists curriculum_textbooks_taxonomy_idx
  on public.curriculum_textbooks (stage, subject, edition, grade);

create index if not exists curriculum_textbooks_title_idx
  on public.curriculum_textbooks (title);

create index if not exists curriculum_nodes_parent_idx
  on public.curriculum_nodes (textbook_id, parent_id, sort_no);

create index if not exists curriculum_nodes_level_idx
  on public.curriculum_nodes (textbook_id, level, sort_no);

alter table public.curriculum_textbooks enable row level security;
alter table public.curriculum_nodes enable row level security;

revoke all on public.curriculum_textbooks from public, anon, authenticated;
revoke all on public.curriculum_nodes from public, anon, authenticated;
grant select, insert, update, delete on public.curriculum_textbooks to service_role;
grant select, insert, update, delete on public.curriculum_nodes to service_role;
