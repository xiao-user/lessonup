alter table public.lesson_design_basis_entries
  drop constraint if exists lesson_design_basis_entries_kind_check;

alter table public.lesson_design_basis_entries
  add constraint lesson_design_basis_entries_kind_check
  check (kind in (
    'knowledge_point',
    'review',
    'prepare',
    'student_difficulty',
    'assessment_evidence',
    'teaching_decision'
  ));

alter table public.lesson_design_basis_entries
  drop constraint if exists lesson_design_basis_entries_check;

alter table public.lesson_design_basis_entries
  add constraint lesson_design_basis_entries_check
  check (
    (kind = 'knowledge_point' and semantic_entity_id is not null
      and related_semantic_entity_id is null and related_curriculum_node_id is null)
    or (kind in ('review', 'prepare') and semantic_entity_id is not null
      and related_semantic_entity_id is not null and related_curriculum_node_id is not null)
    or (kind in (
      'student_difficulty', 'assessment_evidence', 'teaching_decision'
    ) and related_semantic_entity_id is null and related_curriculum_node_id is null)
  );
