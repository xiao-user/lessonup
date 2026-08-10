-- Track whether weak/skipped continuity feedback still needs next-blueprint writeback.

alter table public.lesson_class_feedback
  add column if not exists writeback_status text
    check (
      writeback_status is null
      or writeback_status in ('pending', 'applied', 'not_applicable')
    );

comment on column public.lesson_class_feedback.writeback_status is
  'pending=awaiting next-blueprint approval; applied=writeback approved; not_applicable=no writeback needed';

create index if not exists lesson_class_feedback_writeback_pending_idx
  on public.lesson_class_feedback(owner_id, semester_framework_id, writeback_status)
  where writeback_status = 'pending';
