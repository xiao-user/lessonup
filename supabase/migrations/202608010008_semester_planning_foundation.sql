-- Semester planning aggregate. Every curriculum reference is pinned to one
-- immutable catalog release so a framework remains replayable after upgrades.

alter table public.curriculum_semantic_releases
  add constraint curriculum_semantic_releases_id_catalog_unique
  unique (id, catalog_release_id);

create table public.semester_frameworks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  notebook_id text not null,
  textbook_id text not null,
  catalog_release_id uuid not null,
  semantic_release_id uuid,
  title text not null,
  term text not null check (char_length(trim(term)) between 1 and 40),
  start_date date,
  total_weeks integer not null check (total_weeks between 1 and 30),
  weekly_periods integer not null check (weekly_periods between 1 and 30),
  lesson_duration_minutes integer not null default 40
    check (lesson_duration_minutes between 20 and 180),
  capacity_ratio numeric(4,3) not null default 0.9
    check (capacity_ratio between 0.5 and 1),
  planning_horizon_weeks integer not null default 2
    check (planning_horizon_weeks between 1 and 8),
  context_profile jsonb not null default '{}'::jsonb,
  version integer not null default 0 check (version >= 0),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'completed', 'archived')),
  create_idempotency_key text not null,
  create_request_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, create_idempotency_key),
  unique (owner_id, id, catalog_release_id, textbook_id),
  unique (owner_id, id, semantic_release_id),
  foreign key (owner_id, notebook_id)
    references public.notebooks(owner_id, id) on delete cascade,
  foreign key (catalog_release_id, textbook_id)
    references public.curriculum_textbook_revisions(catalog_release_id, textbook_id)
    on delete restrict,
  foreign key (semantic_release_id, catalog_release_id)
    references public.curriculum_semantic_releases(id, catalog_release_id)
    on delete restrict,
  check (planning_horizon_weeks <= total_weeks)
);

create table public.semester_units (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  framework_id uuid not null,
  catalog_release_id uuid not null,
  textbook_id text not null,
  curriculum_node_id text not null,
  sort_no integer not null check (sort_no > 0),
  planned_start_week integer check (planned_start_week between 1 and 30),
  planned_end_week integer check (planned_end_week between 1 and 30),
  planned_periods integer not null default 0 check (planned_periods between 0 and 100),
  learning_goals text not null default '',
  teacher_notes text not null default '',
  status text not null default 'unplanned'
    check (status in ('unplanned', 'planned', 'in_progress', 'completed', 'deferred')),
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, framework_id, id),
  unique (owner_id, framework_id, curriculum_node_id),
  unique (owner_id, framework_id, sort_no),
  foreign key (owner_id, framework_id, catalog_release_id, textbook_id)
    references public.semester_frameworks(owner_id, id, catalog_release_id, textbook_id)
    on delete cascade,
  foreign key (catalog_release_id, textbook_id, curriculum_node_id)
    references public.curriculum_node_revisions(catalog_release_id, textbook_id, node_id)
    on delete restrict,
  check (
    planned_start_week is null
    or planned_end_week is null
    or planned_start_week <= planned_end_week
  )
);

create table public.lesson_blueprints (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  framework_id uuid not null,
  semester_unit_id uuid not null,
  catalog_release_id uuid not null,
  textbook_id text not null,
  curriculum_node_id text not null,
  planned_period integer not null check (planned_period > 0),
  sort_no integer not null check (sort_no > 0),
  title text not null,
  main_activity text not null default '',
  observable_product text not null default '',
  assessment_evidence text not null default '',
  anticipated_difficulties jsonb not null default '[]'::jsonb,
  planned_minutes integer check (planned_minutes between 1 and 180),
  teacher_notes text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'taught', 'adjusted', 'cancelled')),
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, framework_id, id),
  unique (owner_id, framework_id, semester_unit_id, planned_period),
  unique (owner_id, framework_id, sort_no),
  foreign key (owner_id, framework_id, catalog_release_id, textbook_id)
    references public.semester_frameworks(owner_id, id, catalog_release_id, textbook_id)
    on delete cascade,
  foreign key (owner_id, framework_id, semester_unit_id)
    references public.semester_units(owner_id, framework_id, id)
    on delete cascade,
  foreign key (catalog_release_id, textbook_id, curriculum_node_id)
    references public.curriculum_node_revisions(catalog_release_id, textbook_id, node_id)
    on delete restrict,
  check (jsonb_typeof(anticipated_difficulties) = 'array')
);

create table public.framework_outcome_selections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  framework_id uuid not null,
  semester_unit_id uuid,
  lesson_blueprint_id uuid,
  semantic_release_id uuid not null,
  semantic_entity_id uuid not null,
  priority integer not null default 1 check (priority between 1 and 10),
  teacher_confirmed boolean not null default false,
  teacher_adjusted boolean not null default false,
  adjustment_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, framework_id, semantic_release_id)
    references public.semester_frameworks(owner_id, id, semantic_release_id)
    on delete cascade,
  foreign key (owner_id, framework_id, semester_unit_id)
    references public.semester_units(owner_id, framework_id, id)
    on delete cascade,
  foreign key (owner_id, framework_id, lesson_blueprint_id)
    references public.lesson_blueprints(owner_id, framework_id, id)
    on delete cascade,
  foreign key (semantic_release_id, semantic_entity_id)
    references public.curriculum_semantic_entity_revisions(release_id, semantic_entity_id)
    on delete restrict,
  check (num_nonnulls(semester_unit_id, lesson_blueprint_id) = 1),
  check (not teacher_adjusted or char_length(trim(adjustment_reason)) > 0)
);

create table public.semester_framework_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  framework_id uuid not null,
  framework_version integer not null check (framework_version >= 0),
  snapshot jsonb not null,
  actor text not null check (actor in ('manual', 'agent', 'import')),
  run_id uuid,
  approval_id uuid,
  idempotency_key text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  foreign key (owner_id, framework_id)
    references public.semester_frameworks(owner_id, id) on delete cascade,
  unique (owner_id, framework_id, framework_version),
  unique (owner_id, idempotency_key)
);

create index semester_frameworks_owner_notebook_updated_idx
  on public.semester_frameworks(owner_id, notebook_id, updated_at desc);
create index semester_units_framework_order_idx
  on public.semester_units(owner_id, framework_id, sort_no);
create index lesson_blueprints_framework_order_idx
  on public.lesson_blueprints(owner_id, framework_id, sort_no);
create index framework_outcome_selections_entity_idx
  on public.framework_outcome_selections(semantic_release_id, semantic_entity_id);
create unique index framework_outcome_selections_unit_unique_idx
  on public.framework_outcome_selections(
    owner_id, framework_id, semester_unit_id, semantic_release_id, semantic_entity_id
  )
  where semester_unit_id is not null;
create unique index framework_outcome_selections_blueprint_unique_idx
  on public.framework_outcome_selections(
    owner_id, framework_id, lesson_blueprint_id, semantic_release_id, semantic_entity_id
  )
  where lesson_blueprint_id is not null;

alter table public.semester_frameworks enable row level security;
alter table public.semester_units enable row level security;
alter table public.lesson_blueprints enable row level security;
alter table public.framework_outcome_selections enable row level security;
alter table public.semester_framework_versions enable row level security;

revoke all on public.semester_frameworks,
  public.semester_units,
  public.lesson_blueprints,
  public.framework_outcome_selections,
  public.semester_framework_versions
  from public, anon, authenticated;
grant select, insert, update, delete on public.semester_frameworks,
  public.semester_units,
  public.lesson_blueprints,
  public.framework_outcome_selections,
  public.semester_framework_versions
  to service_role;

create or replace function public.semester_framework_snapshot(
  p_owner_id uuid,
  p_framework_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'framework', to_jsonb(framework)
      - 'create_idempotency_key'
      - 'create_request_hash',
    'units', coalesce((
      select jsonb_agg(to_jsonb(unit_record) order by unit_record.sort_no)
      from public.semester_units unit_record
      where unit_record.owner_id = framework.owner_id
        and unit_record.framework_id = framework.id
    ), '[]'::jsonb),
    'blueprints', coalesce((
      select jsonb_agg(to_jsonb(blueprint) order by blueprint.sort_no)
      from public.lesson_blueprints blueprint
      where blueprint.owner_id = framework.owner_id
        and blueprint.framework_id = framework.id
    ), '[]'::jsonb),
    'outcomeSelections', coalesce((
      select jsonb_agg(to_jsonb(selection) order by selection.created_at, selection.id)
      from public.framework_outcome_selections selection
      where selection.owner_id = framework.owner_id
        and selection.framework_id = framework.id
    ), '[]'::jsonb)
  )
  from public.semester_frameworks framework
  where framework.owner_id = p_owner_id and framework.id = p_framework_id;
$$;

create or replace function public.create_semester_framework(
  p_owner_id uuid,
  p_framework_id uuid,
  p_notebook_id text,
  p_textbook_id text,
  p_title text,
  p_term text,
  p_start_date date,
  p_total_weeks integer,
  p_weekly_periods integer,
  p_lesson_duration_minutes integer,
  p_capacity_ratio numeric,
  p_planning_horizon_weeks integer,
  p_context_profile jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_release public.curriculum_catalog_releases%rowtype;
  selected_semantic_release_id uuid;
  existing_framework public.semester_frameworks%rowtype;
  created_framework public.semester_frameworks%rowtype;
  notebook_record public.notebooks%rowtype;
  textbook_record public.curriculum_textbook_revisions%rowtype;
  request_hash text;
  snapshot jsonb;
begin
  perform public.assert_service_scope(p_owner_id);

  request_hash := encode(extensions.digest(jsonb_build_object(
    'notebookId', p_notebook_id,
    'textbookId', p_textbook_id,
    'title', p_title,
    'term', p_term,
    'startDate', p_start_date,
    'totalWeeks', p_total_weeks,
    'weeklyPeriods', p_weekly_periods,
    'lessonDurationMinutes', p_lesson_duration_minutes,
    'capacityRatio', p_capacity_ratio,
    'planningHorizonWeeks', p_planning_horizon_weeks,
    'contextProfile', coalesce(p_context_profile, '{}'::jsonb)
  )::text, 'sha256'), 'hex');

  select * into existing_framework
  from public.semester_frameworks
  where owner_id = p_owner_id and create_idempotency_key = p_idempotency_key;
  if found then
    if existing_framework.create_request_hash <> request_hash then
      raise exception 'idempotency_conflict';
    end if;
    return public.semester_framework_snapshot(p_owner_id, existing_framework.id);
  end if;

  select * into notebook_record
  from public.notebooks
  where owner_id = p_owner_id and id = p_notebook_id;
  if not found then raise exception 'notebook_not_found'; end if;

  select release.* into current_release
  from public.curriculum_catalog_current pointer
  join public.curriculum_catalog_releases release
    on release.id = pointer.catalog_release_id
  where pointer.singleton = true and release.status = 'published';
  if current_release.id is null or not current_release.snapshot_complete then
    raise exception 'curriculum_catalog_snapshot_unavailable';
  end if;

  select * into textbook_record
  from public.curriculum_textbook_revisions textbook
  where textbook.catalog_release_id = current_release.id
    and textbook.textbook_id = p_textbook_id;
  if not found then raise exception 'curriculum_textbook_not_found'; end if;
  if notebook_record.subject <> textbook_record.subject then
    raise exception 'curriculum_subject_mismatch';
  end if;

  select release.id into selected_semantic_release_id
  from public.curriculum_semantic_releases release
  where release.catalog_release_id = current_release.id
    and release.status = 'published'
    and exists (
      select 1 from public.curriculum_node_semantics mapping
      where mapping.release_id = release.id
        and mapping.textbook_id = p_textbook_id
        and mapping.review_state = 'approved'
    )
  order by release.published_at desc, release.created_at desc
  limit 1;

  insert into public.semester_frameworks(
    id, owner_id, notebook_id, textbook_id, catalog_release_id,
    semantic_release_id, title, term, start_date, total_weeks, weekly_periods,
    lesson_duration_minutes, capacity_ratio, planning_horizon_weeks,
    context_profile, create_idempotency_key, create_request_hash
  ) values (
    p_framework_id, p_owner_id, p_notebook_id, p_textbook_id,
    current_release.id, selected_semantic_release_id, p_title, p_term,
    p_start_date, p_total_weeks, p_weekly_periods, p_lesson_duration_minutes,
    p_capacity_ratio, p_planning_horizon_weeks,
    coalesce(p_context_profile, '{}'::jsonb), p_idempotency_key, request_hash
  ) returning * into created_framework;

  insert into public.semester_units(
    owner_id, framework_id, catalog_release_id, textbook_id,
    curriculum_node_id, sort_no
  )
  select p_owner_id, created_framework.id, current_release.id, p_textbook_id,
    node.node_id, (row_number() over (order by node.sort_no, node.node_id))::integer
  from public.curriculum_node_revisions node
  where node.catalog_release_id = current_release.id
    and node.textbook_id = p_textbook_id
    and node.parent_id is null
  order by node.sort_no, node.node_id;

  if not exists (
    select 1 from public.semester_units unit_record
    where unit_record.owner_id = p_owner_id
      and unit_record.framework_id = created_framework.id
  ) then
    raise exception 'curriculum_textbook_has_no_root_nodes';
  end if;

  snapshot := public.semester_framework_snapshot(p_owner_id, created_framework.id);
  insert into public.semester_framework_versions(
    owner_id, framework_id, framework_version, snapshot, actor,
    idempotency_key, request_hash
  ) values (
    p_owner_id, created_framework.id, 0, snapshot, 'manual',
    'create:' || p_idempotency_key, request_hash
  );

  return snapshot;
end;
$$;

revoke all on function public.semester_framework_snapshot(uuid, uuid),
  public.create_semester_framework(
    uuid, uuid, text, text, text, text, date, integer, integer, integer,
    numeric, integer, jsonb, text
  )
  from public, anon, authenticated;
grant execute on function public.semester_framework_snapshot(uuid, uuid),
  public.create_semester_framework(
    uuid, uuid, text, text, text, text, date, integer, integer, integer,
    numeric, integer, jsonb, text
  )
  to service_role;
