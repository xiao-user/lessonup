-- A search can observe several passages from one source. Keep source_id as the
-- canonical citation source while using a passage-aware key for idempotent
-- evidence persistence within a run.
alter table public.agent_run_evidence
  add column if not exists evidence_key text;

update public.agent_run_evidence
set evidence_key = 'source:' || source_id
where evidence_key is null;

alter table public.agent_run_evidence
  alter column evidence_key set not null;

alter table public.agent_run_evidence
  drop constraint if exists agent_run_evidence_owner_id_run_id_kind_source_id_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agent_run_evidence_identity_unique'
      and conrelid = 'public.agent_run_evidence'::regclass
  ) then
    alter table public.agent_run_evidence
      add constraint agent_run_evidence_identity_unique
      unique (owner_id, run_id, kind, evidence_key);
  end if;
end
$$;
