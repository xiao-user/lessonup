revoke all on table public.classroom_presentations from anon, authenticated;
revoke all on table public.classroom_presentation_revisions from anon, authenticated;
revoke all on table public.classroom_presentation_jobs from anon, authenticated;
revoke all on table public.classroom_presentation_artifacts from anon, authenticated;
revoke all on table public.classroom_presentation_revision_sessions from anon, authenticated;

grant select, insert, update, delete on table public.classroom_presentations to service_role;
grant select, insert, update, delete on table public.classroom_presentation_revisions to service_role;
grant select, insert, update, delete on table public.classroom_presentation_jobs to service_role;
grant select, insert, update, delete on table public.classroom_presentation_artifacts to service_role;
grant select, insert, update, delete on table public.classroom_presentation_revision_sessions to service_role;
