-- Generation rows are transient render status, not presentation artifacts.
-- Remove legacy direct-A4 jobs before enforcing the approved-script boundary.
delete from public.classroom_presentation_generations
where storyboard is null;

alter table public.classroom_presentation_generations
  alter column storyboard set not null,
  drop column if exists direction;

comment on column public.classroom_presentation_generations.storyboard is
  'Immutable teacher-approved content contract; the Dashi compiler must not receive the source A4 document.';
