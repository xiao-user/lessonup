-- Local and hosted Supabase use safe-update checks. Keep the atomic replacement,
-- but make the intentional full-table scope explicit.
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
