alter table public.agent_branches
  add column if not exists pending_interaction jsonb;

alter table public.agent_branches
  drop constraint if exists agent_branches_pending_interaction_shape;
alter table public.agent_branches
  add constraint agent_branches_pending_interaction_shape check (
    pending_interaction is null or (
      pending_interaction->>'kind' = 'presentation_theme'
      and jsonb_typeof(pending_interaction->'originalRequest') = 'string'
      and jsonb_typeof(pending_interaction->'documentVersion') = 'number'
      and jsonb_typeof(pending_interaction->'requestedAt') = 'string'
    )
  );

