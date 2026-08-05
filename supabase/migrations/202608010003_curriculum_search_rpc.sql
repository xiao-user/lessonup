create or replace function public.search_curriculum_textbooks(
  p_stage text default null,
  p_subject text default null,
  p_edition text default null,
  p_grade text default null,
  p_query text default null,
  p_limit integer default 20
)
returns setof public.curriculum_textbooks
language sql
stable
security definer
set search_path = public
as $$
  select textbook.*
  from public.curriculum_textbooks textbook
  where (p_stage is null or textbook.stage = p_stage)
    and (p_subject is null or textbook.subject = p_subject)
    and (p_edition is null or textbook.edition = p_edition)
    and (p_grade is null or textbook.grade = p_grade)
    and (
      p_query is null
      or concat_ws(' ', textbook.title, textbook.volume, textbook.edition, textbook.subject)
        ilike '%' || p_query || '%'
    )
  order by textbook.stage, textbook.subject, textbook.edition, textbook.title
  limit least(200, greatest(1, p_limit));
$$;

revoke execute on function public.search_curriculum_textbooks(text,text,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.search_curriculum_textbooks(text,text,text,text,text,integer)
  to service_role;
