-- Immutable curriculum catalog releases.
-- The existing curriculum_textbooks/curriculum_nodes tables remain the current
-- read projection so existing product flows do not need a flag-day migration.

create table public.curriculum_catalog_releases (
  id uuid primary key default gen_random_uuid(),
  generation_id text not null unique,
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  snapshot_complete boolean not null default true,
  manifest jsonb not null default '{}'::jsonb,
  textbook_count integer not null default 0 check (textbook_count >= 0),
  node_count integer not null default 0 check (node_count >= 0),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  retired_at timestamptz
);

create unique index curriculum_catalog_one_published_release_idx
  on public.curriculum_catalog_releases(status)
  where status = 'published';

create table public.curriculum_textbook_revisions (
  catalog_release_id uuid not null
    references public.curriculum_catalog_releases(id) on delete restrict,
  textbook_id text not null,
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
  source_recorded_at timestamptz not null,
  primary key (catalog_release_id, textbook_id)
);

create table public.curriculum_node_revisions (
  catalog_release_id uuid not null,
  textbook_id text not null,
  node_id text not null,
  parent_id text,
  level integer not null check (level between 1 and 8),
  sort_no integer not null,
  title text not null,
  page_number integer,
  primary key (catalog_release_id, textbook_id, node_id),
  foreign key (catalog_release_id, textbook_id)
    references public.curriculum_textbook_revisions(catalog_release_id, textbook_id)
    on delete restrict,
  constraint curriculum_node_revisions_parent_fk
    foreign key (catalog_release_id, textbook_id, parent_id)
    references public.curriculum_node_revisions(catalog_release_id, textbook_id, node_id)
    on delete restrict
    deferrable initially deferred
);

create table public.curriculum_catalog_current (
  singleton boolean primary key default true check (singleton),
  catalog_release_id uuid not null unique
    references public.curriculum_catalog_releases(id) on delete restrict,
  activated_at timestamptz not null default now()
);

create index curriculum_textbook_revisions_taxonomy_idx
  on public.curriculum_textbook_revisions(
    catalog_release_id, stage, subject, edition, grade
  );
create index curriculum_node_revisions_parent_idx
  on public.curriculum_node_revisions(
    catalog_release_id, textbook_id, parent_id, sort_no
  );
create index curriculum_node_revisions_level_idx
  on public.curriculum_node_revisions(
    catalog_release_id, textbook_id, level, sort_no
  );

alter table public.curriculum_catalog_releases enable row level security;
alter table public.curriculum_textbook_revisions enable row level security;
alter table public.curriculum_node_revisions enable row level security;
alter table public.curriculum_catalog_current enable row level security;

revoke all on public.curriculum_catalog_releases,
  public.curriculum_textbook_revisions,
  public.curriculum_node_revisions,
  public.curriculum_catalog_current
  from public, anon, authenticated;
grant select on public.curriculum_catalog_releases,
  public.curriculum_textbook_revisions,
  public.curriculum_node_revisions,
  public.curriculum_catalog_current
  to service_role;

-- Preserve the current live catalog as the first immutable release.
do $$
declare
  current_generation text;
  current_manifest jsonb;
  current_published_at timestamptz;
  current_release_id uuid;
  semantic_generation text;
begin
  select state.generation_id, state.manifest, state.published_at
    into current_generation, current_manifest, current_published_at
  from public.curriculum_catalog_state state
  where state.singleton = true;

  if current_generation is not null then
    insert into public.curriculum_catalog_releases(
      generation_id, status, snapshot_complete, manifest,
      textbook_count, node_count, published_at
    ) values (
      current_generation, 'published', true, coalesce(current_manifest, '{}'::jsonb),
      (select count(*) from public.curriculum_textbooks where retired_at is null),
      (select count(*) from public.curriculum_nodes where retired_at is null),
      coalesce(current_published_at, now())
    )
    returning id into current_release_id;

    insert into public.curriculum_textbook_revisions(
      catalog_release_id, textbook_id, title, stage, subject, edition, grade,
      volume, publisher_id, ebook_id, detail_url, tree_url, source_pdf_url,
      source_list_url, node_count, source_updated_at, source_recorded_at
    )
    select current_release_id, textbook.id, textbook.title, textbook.stage,
      textbook.subject, textbook.edition, textbook.grade, textbook.volume,
      textbook.publisher_id, textbook.ebook_id, textbook.detail_url,
      textbook.tree_url, textbook.source_pdf_url, textbook.source_list_url,
      textbook.node_count, textbook.source_updated_at, textbook.updated_at
    from public.curriculum_textbooks textbook
    where textbook.retired_at is null;

    set constraints curriculum_node_revisions_parent_fk deferred;
    insert into public.curriculum_node_revisions(
      catalog_release_id, textbook_id, node_id, parent_id, level, sort_no,
      title, page_number
    )
    select current_release_id, node.textbook_id, node.node_id, node.parent_id,
      node.level, node.sort_no, node.title, node.page_number
    from public.curriculum_nodes node
    where node.retired_at is null;

    insert into public.curriculum_catalog_current(singleton, catalog_release_id, activated_at)
    values (true, current_release_id, coalesce(current_published_at, now()));
  end if;

  -- Older semantic releases may predate catalog snapshots. Keep their identity
  -- explicit instead of silently binding them to a different catalog. Such a
  -- placeholder is intentionally marked snapshot_complete=false.
  for semantic_generation in
    select distinct release.catalog_generation_id
    from public.curriculum_semantic_releases release
    where not exists (
      select 1
      from public.curriculum_catalog_releases catalog_release
      where catalog_release.generation_id = release.catalog_generation_id
    )
  loop
    insert into public.curriculum_catalog_releases(
      generation_id, status, snapshot_complete, manifest
    ) values (
      semantic_generation, 'retired', false,
      jsonb_build_object('migration', 'historical_snapshot_unavailable')
    );
  end loop;
end
$$;

alter table public.curriculum_semantic_releases
  add column catalog_release_id uuid;

update public.curriculum_semantic_releases semantic_release
set catalog_release_id = catalog_release.id
from public.curriculum_catalog_releases catalog_release
where catalog_release.generation_id = semantic_release.catalog_generation_id
  and semantic_release.catalog_release_id is null;

alter table public.curriculum_semantic_releases
  alter column catalog_release_id set not null,
  add constraint curriculum_semantic_releases_catalog_release_fk
    foreign key (catalog_release_id)
    references public.curriculum_catalog_releases(id)
    on delete restrict;

create index curriculum_semantic_releases_catalog_release_idx
  on public.curriculum_semantic_releases(catalog_release_id, status);

-- Existing importers provide catalog_generation_id. Resolve that stable hash to
-- the immutable release in the database so callers cannot accidentally bind the
-- semantic graph to a different snapshot.
create or replace function public.bind_curriculum_semantic_catalog_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_release public.curriculum_catalog_releases%rowtype;
begin
  if new.catalog_release_id is null then
    select * into resolved_release
    from public.curriculum_catalog_releases release
    where release.generation_id = new.catalog_generation_id;
  else
    select * into resolved_release
    from public.curriculum_catalog_releases release
    where release.id = new.catalog_release_id;
  end if;

  if resolved_release.id is null then
    raise exception 'curriculum_catalog_release_not_found';
  end if;
  if resolved_release.generation_id is distinct from new.catalog_generation_id then
    raise exception 'curriculum_catalog_release_generation_mismatch';
  end if;

  new.catalog_release_id := resolved_release.id;
  return new;
end;
$$;

create trigger curriculum_semantic_release_catalog_binding
before insert or update of catalog_generation_id, catalog_release_id
on public.curriculum_semantic_releases
for each row execute function public.bind_curriculum_semantic_catalog_release();

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
  target_release public.curriculum_catalog_releases%rowtype;
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
    from curriculum_nodes_staging node
    left join curriculum_nodes_staging parent
      on parent.import_id = node.import_id
      and parent.textbook_id = node.textbook_id
      and parent.node_id = node.parent_id
    where node.import_id = p_import_id
      and node.parent_id is not null
      and parent.node_id is null
  ) then
    raise exception 'curriculum_staging_orphan_node';
  end if;
  if exists (
    select 1
    from curriculum_textbooks_staging textbook
    left join (
      select textbook_id, count(*) as node_count
      from curriculum_nodes_staging
      where import_id = p_import_id
      group by textbook_id
    ) nodes on nodes.textbook_id = textbook.id
    where textbook.import_id = p_import_id
      and textbook.node_count <> coalesce(nodes.node_count, 0)
  ) then
    raise exception 'curriculum_staging_book_count_mismatch';
  end if;

  select * into target_release
  from public.curriculum_catalog_releases release
  where release.generation_id = p_generation_id
  for update;

  if target_release.id is null then
    insert into public.curriculum_catalog_releases(
      generation_id, status, snapshot_complete, manifest,
      textbook_count, node_count
    ) values (
      p_generation_id, 'draft', true, p_manifest,
      p_expected_textbooks, p_expected_nodes
    ) returning * into target_release;

    insert into public.curriculum_textbook_revisions(
      catalog_release_id, textbook_id, title, stage, subject, edition, grade,
      volume, publisher_id, ebook_id, detail_url, tree_url, source_pdf_url,
      source_list_url, node_count, source_updated_at, source_recorded_at
    )
    select target_release.id, id, title, stage, subject, edition, grade,
      volume, publisher_id, ebook_id, detail_url, tree_url, source_pdf_url,
      source_list_url, node_count, source_updated_at, updated_at
    from public.curriculum_textbooks_staging
    where import_id = p_import_id;

    set constraints curriculum_node_revisions_parent_fk deferred;
    insert into public.curriculum_node_revisions(
      catalog_release_id, textbook_id, node_id, parent_id, level, sort_no,
      title, page_number
    )
    select target_release.id, textbook_id, node_id, parent_id, level, sort_no,
      title, page_number
    from public.curriculum_nodes_staging
    where import_id = p_import_id;
  elsif not target_release.snapshot_complete then
    if exists (
      select 1 from public.curriculum_textbook_revisions revision
      where revision.catalog_release_id = target_release.id
    ) or exists (
      select 1 from public.curriculum_node_revisions revision
      where revision.catalog_release_id = target_release.id
    ) then
      raise exception 'curriculum_catalog_incomplete_release_has_rows';
    end if;

    insert into public.curriculum_textbook_revisions(
      catalog_release_id, textbook_id, title, stage, subject, edition, grade,
      volume, publisher_id, ebook_id, detail_url, tree_url, source_pdf_url,
      source_list_url, node_count, source_updated_at, source_recorded_at
    )
    select target_release.id, id, title, stage, subject, edition, grade,
      volume, publisher_id, ebook_id, detail_url, tree_url, source_pdf_url,
      source_list_url, node_count, source_updated_at, updated_at
    from public.curriculum_textbooks_staging
    where import_id = p_import_id;

    set constraints curriculum_node_revisions_parent_fk deferred;
    insert into public.curriculum_node_revisions(
      catalog_release_id, textbook_id, node_id, parent_id, level, sort_no,
      title, page_number
    )
    select target_release.id, textbook_id, node_id, parent_id, level, sort_no,
      title, page_number
    from public.curriculum_nodes_staging
    where import_id = p_import_id;

    update public.curriculum_catalog_releases
    set snapshot_complete = true,
        manifest = p_manifest,
        textbook_count = p_expected_textbooks,
        node_count = p_expected_nodes
    where id = target_release.id;
  else
    if target_release.textbook_count <> p_expected_textbooks
      or target_release.node_count <> p_expected_nodes
      or exists (
        select id, title, stage, subject, edition, grade, volume, publisher_id,
          ebook_id, detail_url, tree_url, source_pdf_url, source_list_url,
          node_count, source_updated_at
        from public.curriculum_textbooks_staging
        where import_id = p_import_id
        except
        select textbook_id, title, stage, subject, edition, grade, volume, publisher_id,
          ebook_id, detail_url, tree_url, source_pdf_url, source_list_url,
          node_count, source_updated_at
        from public.curriculum_textbook_revisions
        where catalog_release_id = target_release.id
      ) or exists (
        select textbook_id, node_id, parent_id, level, sort_no, title, page_number
        from public.curriculum_nodes_staging
        where import_id = p_import_id
        except
        select textbook_id, node_id, parent_id, level, sort_no, title, page_number
        from public.curriculum_node_revisions
        where catalog_release_id = target_release.id
      ) then
      raise exception 'curriculum_catalog_release_immutable';
    end if;
  end if;

  -- Refresh the backwards-compatible current projection.
  set constraints curriculum_nodes_parent_fk deferred;
  insert into public.curriculum_textbooks (
    id, title, stage, subject, edition, grade, volume, publisher_id,
    ebook_id, detail_url, tree_url, source_pdf_url, source_list_url,
    node_count, source_updated_at, updated_at, catalog_generation_id, retired_at
  )
  select id, title, stage, subject, edition, grade, volume, publisher_id,
    ebook_id, detail_url, tree_url, source_pdf_url, source_list_url,
    node_count, source_updated_at, updated_at, p_generation_id, null
  from public.curriculum_textbooks_staging
  where import_id = p_import_id
  on conflict (id) do update set
    title = excluded.title,
    stage = excluded.stage,
    subject = excluded.subject,
    edition = excluded.edition,
    grade = excluded.grade,
    volume = excluded.volume,
    publisher_id = excluded.publisher_id,
    ebook_id = excluded.ebook_id,
    detail_url = excluded.detail_url,
    tree_url = excluded.tree_url,
    source_pdf_url = excluded.source_pdf_url,
    source_list_url = excluded.source_list_url,
    node_count = excluded.node_count,
    source_updated_at = excluded.source_updated_at,
    updated_at = excluded.updated_at,
    catalog_generation_id = excluded.catalog_generation_id,
    retired_at = null;

  insert into public.curriculum_nodes (
    textbook_id, node_id, parent_id, level, sort_no, title, page_number,
    catalog_generation_id, retired_at
  )
  select textbook_id, node_id, parent_id, level, sort_no, title, page_number,
    p_generation_id, null
  from public.curriculum_nodes_staging
  where import_id = p_import_id
  on conflict (textbook_id, node_id) do update set
    parent_id = excluded.parent_id,
    level = excluded.level,
    sort_no = excluded.sort_no,
    title = excluded.title,
    page_number = excluded.page_number,
    catalog_generation_id = excluded.catalog_generation_id,
    retired_at = null;

  update public.curriculum_nodes node
  set retired_at = now()
  where node.retired_at is null
    and not exists (
      select 1 from public.curriculum_nodes_staging staged
      where staged.import_id = p_import_id
        and staged.textbook_id = node.textbook_id
        and staged.node_id = node.node_id
    );

  update public.curriculum_textbooks textbook
  set retired_at = now(), updated_at = now()
  where textbook.retired_at is null
    and not exists (
      select 1 from public.curriculum_textbooks_staging staged
      where staged.import_id = p_import_id and staged.id = textbook.id
    );

  update public.curriculum_catalog_releases
  set status = 'retired', retired_at = now()
  where status = 'published' and id <> target_release.id;
  update public.curriculum_catalog_releases
  set status = 'published',
      published_at = coalesce(published_at, now()),
      retired_at = null
  where id = target_release.id;

  insert into public.curriculum_catalog_current(singleton, catalog_release_id, activated_at)
  values (true, target_release.id, now())
  on conflict (singleton) do update
  set catalog_release_id = excluded.catalog_release_id,
      activated_at = excluded.activated_at;

  insert into public.curriculum_catalog_state(singleton, generation_id, manifest, published_at)
  values (true, p_generation_id, p_manifest, now())
  on conflict (singleton) do update
  set generation_id = excluded.generation_id,
      manifest = excluded.manifest,
      published_at = excluded.published_at;

  delete from public.curriculum_textbooks_staging where import_id = p_import_id;
end
$$;

revoke all on function public.publish_curriculum_catalog(
  uuid, text, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.publish_curriculum_catalog(
  uuid, text, integer, integer, jsonb
) to service_role;
