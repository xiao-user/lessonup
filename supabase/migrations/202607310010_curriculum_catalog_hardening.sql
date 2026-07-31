-- Publish a fully validated curriculum generation atomically. Failed imports remain
-- isolated in staging and cannot empty or partially replace the live catalog.

alter table public.curriculum_textbooks
  rename column publisher to publisher_id;

alter table public.curriculum_textbooks
  add column if not exists detail_url text,
  add column if not exists tree_url text,
  add column if not exists source_pdf_url text,
  add column if not exists source_list_url text;

alter table public.curriculum_nodes
  add constraint curriculum_nodes_parent_fk
  foreign key (textbook_id, parent_id)
  references public.curriculum_nodes(textbook_id, node_id)
  on delete cascade
  deferrable initially deferred;

create table public.curriculum_catalog_state (
  singleton boolean primary key default true check (singleton),
  generation_id text not null,
  manifest jsonb not null,
  published_at timestamptz not null default now()
);

create table public.curriculum_textbooks_staging (
  import_id uuid not null,
  id text not null,
  title text not null,
  stage text not null,
  subject text not null,
  edition text not null,
  grade text not null,
  volume text not null default '',
  publisher_id text not null default '',
  ebook_id text,
  detail_url text,
  tree_url text,
  source_pdf_url text,
  source_list_url text,
  node_count integer not null check (node_count >= 0),
  source_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (import_id, id)
);

create table public.curriculum_nodes_staging (
  import_id uuid not null,
  textbook_id text not null,
  node_id text not null,
  parent_id text,
  level integer not null check (level between 1 and 8),
  sort_no integer not null,
  title text not null,
  page_number integer,
  primary key (import_id, textbook_id, node_id),
  foreign key (import_id, textbook_id)
    references public.curriculum_textbooks_staging(import_id, id)
    on delete cascade
);

alter table public.curriculum_catalog_state enable row level security;
alter table public.curriculum_textbooks_staging enable row level security;
alter table public.curriculum_nodes_staging enable row level security;
revoke all on public.curriculum_catalog_state,
  public.curriculum_textbooks_staging,
  public.curriculum_nodes_staging
  from public, anon, authenticated;
grant select, insert, update, delete on public.curriculum_catalog_state,
  public.curriculum_textbooks_staging,
  public.curriculum_nodes_staging
  to service_role;

create or replace function public.publish_curriculum_catalog(
  p_import_id uuid,
  p_generation_id text,
  p_expected_textbooks integer,
  p_expected_nodes integer,
  p_manifest jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actual_textbooks integer;
  actual_nodes integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  select count(*) into actual_textbooks
  from curriculum_textbooks_staging where import_id = p_import_id;
  select count(*) into actual_nodes
  from curriculum_nodes_staging where import_id = p_import_id;
  if actual_textbooks <> p_expected_textbooks or actual_nodes <> p_expected_nodes then
    raise exception 'curriculum_staging_count_mismatch';
  end if;
  if exists (
    select 1
    from curriculum_nodes_staging n
    left join curriculum_nodes_staging p
      on p.import_id = n.import_id
      and p.textbook_id = n.textbook_id
      and p.node_id = n.parent_id
    where n.import_id = p_import_id
      and n.parent_id is not null
      and p.node_id is null
  ) then
    raise exception 'curriculum_staging_orphan_node';
  end if;
  if exists (
    select 1
    from curriculum_textbooks_staging b
    left join (
      select textbook_id, count(*) as node_count
      from curriculum_nodes_staging
      where import_id = p_import_id
      group by textbook_id
    ) n on n.textbook_id = b.id
    where b.import_id = p_import_id
      and b.node_count <> coalesce(n.node_count, 0)
  ) then
    raise exception 'curriculum_staging_book_count_mismatch';
  end if;

  set constraints curriculum_nodes_parent_fk deferred;
  delete from curriculum_nodes where textbook_id is not null;
  delete from curriculum_textbooks where id is not null;

  insert into curriculum_textbooks (
    id, title, stage, subject, edition, grade, volume, publisher_id,
    ebook_id, detail_url, tree_url, source_pdf_url, source_list_url,
    node_count, source_updated_at, updated_at
  )
  select id, title, stage, subject, edition, grade, volume, publisher_id,
    ebook_id, detail_url, tree_url, source_pdf_url, source_list_url,
    node_count, source_updated_at, updated_at
  from curriculum_textbooks_staging
  where import_id = p_import_id;

  insert into curriculum_nodes (
    textbook_id, node_id, parent_id, level, sort_no, title, page_number
  )
  select textbook_id, node_id, parent_id, level, sort_no, title, page_number
  from curriculum_nodes_staging
  where import_id = p_import_id;

  insert into curriculum_catalog_state(singleton, generation_id, manifest, published_at)
  values (true, p_generation_id, p_manifest, now())
  on conflict (singleton) do update
  set generation_id = excluded.generation_id,
      manifest = excluded.manifest,
      published_at = excluded.published_at;

  delete from curriculum_textbooks_staging where import_id = p_import_id;
end
$$;

revoke all on function public.publish_curriculum_catalog(
  uuid, text, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.publish_curriculum_catalog(
  uuid, text, integer, integer, jsonb
) to service_role;

alter table public.agent_run_evidence
  drop constraint if exists agent_run_evidence_kind_check;
alter table public.agent_run_evidence
  add constraint agent_run_evidence_kind_check check (
    kind in (
      'knowledge_search', 'knowledge_passage', 'attachment_read',
      'source_metadata', 'web_search', 'web_open',
      'curriculum_textbook', 'curriculum_outline'
    )
  );
