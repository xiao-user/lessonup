-- Make key knowledge a first-class A4 field and read chapter knowledge in one
-- server round trip for semester planning.

update public.lesson_files
set document = jsonb_set(document, '{knowledgePoints}', '""'::jsonb, true)
where not (document ? 'knowledgePoints');

update public.lesson_file_versions
set document = jsonb_set(document, '{knowledgePoints}', '""'::jsonb, true)
where not (document ? 'knowledgePoints');

create or replace function public.read_curriculum_nodes_knowledge_points(
  p_textbook_id text,
  p_node_ids text[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(
    requested.node_id,
    public.read_curriculum_node_knowledge_points(p_textbook_id, requested.node_id)
  ), '{}'::jsonb)
  from (
    select distinct node_id
    from unnest(p_node_ids) as item(node_id)
    where char_length(trim(node_id)) between 1 and 80
    limit 100
  ) requested;
$$;

revoke all on function public.read_curriculum_nodes_knowledge_points(text, text[])
from public, anon, authenticated;
grant execute on function public.read_curriculum_nodes_knowledge_points(text, text[])
to service_role;
