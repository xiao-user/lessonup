-- Teacher-owned semester planning aggregate. JSON values are portable fields;
-- validation, snapshots and continuity derivation live in repository services.
CREATE UNIQUE INDEX IF NOT EXISTS notebooks_owner_id_unique_idx ON notebooks(owner_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS curriculum_textbooks_release_id_unique_idx ON curriculum_textbooks(catalog_release_id, id);
CREATE TABLE IF NOT EXISTS semester_frameworks (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, notebook_id TEXT NOT NULL,
  textbook_id TEXT NOT NULL, catalog_release_id TEXT NOT NULL, semantic_release_id TEXT,
  title TEXT NOT NULL, term TEXT NOT NULL, start_date TEXT,
  total_weeks INTEGER NOT NULL, weekly_periods INTEGER NOT NULL,
  lesson_duration_minutes INTEGER NOT NULL DEFAULT 40, capacity_ratio REAL NOT NULL DEFAULT 0.9,
  planning_horizon_weeks INTEGER NOT NULL DEFAULT 2, context_profile_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft',
  create_idempotency_key TEXT NOT NULL, create_request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, notebook_id) REFERENCES notebooks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (catalog_release_id, textbook_id) REFERENCES curriculum_textbooks(catalog_release_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (semantic_release_id) REFERENCES curriculum_semantic_releases(id) ON DELETE RESTRICT,
  UNIQUE (owner_id, id), UNIQUE (owner_id, create_idempotency_key),
  CHECK (length(trim(term)) BETWEEN 1 AND 40), CHECK (total_weeks BETWEEN 1 AND 30),
  CHECK (weekly_periods BETWEEN 1 AND 30), CHECK (lesson_duration_minutes BETWEEN 20 AND 180),
  CHECK (capacity_ratio BETWEEN 0.5 AND 1), CHECK (planning_horizon_weeks BETWEEN 1 AND 8),
  CHECK (planning_horizon_weeks <= total_weeks), CHECK (version >= 0),
  CHECK (status IN ('draft', 'active', 'completed', 'archived'))
);
CREATE INDEX IF NOT EXISTS semester_frameworks_owner_notebook_updated_idx ON semester_frameworks(owner_id, notebook_id, updated_at);

CREATE TABLE IF NOT EXISTS semester_units (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, framework_id TEXT NOT NULL,
  curriculum_node_id TEXT NOT NULL, sort_no INTEGER NOT NULL,
  planned_start_week INTEGER, planned_end_week INTEGER, planned_periods INTEGER NOT NULL DEFAULT 0,
  learning_goals TEXT NOT NULL DEFAULT '', teacher_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unplanned', version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, framework_id) REFERENCES semester_frameworks(owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, framework_id, id), UNIQUE (owner_id, framework_id, curriculum_node_id), UNIQUE (owner_id, framework_id, sort_no),
  CHECK (sort_no > 0), CHECK (planned_start_week IS NULL OR planned_start_week BETWEEN 1 AND 30),
  CHECK (planned_end_week IS NULL OR planned_end_week BETWEEN 1 AND 30),
  CHECK (planned_start_week IS NULL OR planned_end_week IS NULL OR planned_start_week <= planned_end_week),
  CHECK (planned_periods BETWEEN 0 AND 100), CHECK (version >= 0),
  CHECK (status IN ('unplanned', 'planned', 'in_progress', 'completed', 'deferred'))
);
CREATE INDEX IF NOT EXISTS semester_units_framework_order_idx ON semester_units(owner_id, framework_id, sort_no);

CREATE TABLE IF NOT EXISTS lesson_blueprints (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, framework_id TEXT NOT NULL, semester_unit_id TEXT NOT NULL,
  curriculum_node_id TEXT NOT NULL, chapter_period_no INTEGER NOT NULL DEFAULT 1, planned_period INTEGER NOT NULL, sort_no INTEGER NOT NULL,
  title TEXT NOT NULL, main_activity TEXT NOT NULL DEFAULT '', observable_product TEXT NOT NULL DEFAULT '',
  assessment_evidence TEXT NOT NULL DEFAULT '', anticipated_difficulties_json TEXT NOT NULL DEFAULT '[]',
  planned_minutes INTEGER, teacher_notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, framework_id, semester_unit_id) REFERENCES semester_units(owner_id, framework_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, framework_id, id), UNIQUE (owner_id, framework_id, semester_unit_id, planned_period), UNIQUE (owner_id, framework_id, sort_no),
  CHECK (chapter_period_no > 0), CHECK (planned_period > 0), CHECK (sort_no > 0), CHECK (planned_minutes IS NULL OR planned_minutes BETWEEN 1 AND 180),
  CHECK (version >= 0), CHECK (status IN ('draft', 'ready', 'taught', 'adjusted', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS lesson_blueprints_framework_order_idx ON lesson_blueprints(owner_id, framework_id, sort_no);

CREATE TABLE IF NOT EXISTS framework_outcome_selections (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, framework_id TEXT NOT NULL, semester_unit_id TEXT, lesson_blueprint_id TEXT,
  semantic_release_id TEXT NOT NULL, semantic_entity_id TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1,
  teacher_confirmed INTEGER NOT NULL DEFAULT 0, teacher_adjusted INTEGER NOT NULL DEFAULT 0, adjustment_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, framework_id) REFERENCES semester_frameworks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (semantic_release_id, semantic_entity_id) REFERENCES curriculum_semantic_entity_revisions(release_id, semantic_entity_id) ON DELETE RESTRICT,
  UNIQUE (owner_id, framework_id, semester_unit_id, semantic_release_id, semantic_entity_id),
  UNIQUE (owner_id, framework_id, lesson_blueprint_id, semantic_release_id, semantic_entity_id),
  CHECK ((semester_unit_id IS NULL) <> (lesson_blueprint_id IS NULL)), CHECK (priority BETWEEN 1 AND 10),
  CHECK (teacher_confirmed IN (0, 1)), CHECK (teacher_adjusted IN (0, 1)),
  CHECK (teacher_adjusted = 0 OR length(trim(adjustment_reason)) > 0)
);

CREATE TABLE IF NOT EXISTS semester_framework_versions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, framework_id TEXT NOT NULL, framework_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL, actor TEXT NOT NULL, run_id TEXT, approval_id TEXT,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, framework_id) REFERENCES semester_frameworks(owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, framework_id, framework_version), UNIQUE (owner_id, idempotency_key),
  CHECK (framework_version >= 0), CHECK (actor IN ('manual', 'agent', 'import'))
);

CREATE TABLE IF NOT EXISTS framework_continuity_candidates (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, framework_id TEXT NOT NULL, derived_from_framework_version INTEGER NOT NULL,
  target_unit_id TEXT NOT NULL, direction TEXT NOT NULL, semantic_release_id TEXT NOT NULL,
  current_entity_id TEXT NOT NULL, current_point_name TEXT NOT NULL, related_entity_id TEXT NOT NULL, related_point_name TEXT NOT NULL,
  related_unit_id TEXT NOT NULL, evidence_kind TEXT NOT NULL, relation_id TEXT, relation_type TEXT,
  confidence REAL NOT NULL, rationale TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}', fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'candidate', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, framework_id, target_unit_id) REFERENCES semester_units(owner_id, framework_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, framework_id, related_unit_id) REFERENCES semester_units(owner_id, framework_id, id) ON DELETE CASCADE,
  FOREIGN KEY (semantic_release_id, current_entity_id) REFERENCES curriculum_semantic_entity_revisions(release_id, semantic_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (semantic_release_id, related_entity_id) REFERENCES curriculum_semantic_entity_revisions(release_id, semantic_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (semantic_release_id, relation_id) REFERENCES curriculum_semantic_relations(release_id, id) ON DELETE RESTRICT,
  UNIQUE (owner_id, framework_id, fingerprint), CHECK (derived_from_framework_version >= 0),
  CHECK (direction IN ('review', 'prepare')), CHECK (evidence_kind IN ('same_knowledge_point', 'approved_relation')),
  CHECK (confidence BETWEEN 0 AND 1), CHECK (decision IN ('candidate', 'accepted', 'dismissed')), CHECK (active IN (0, 1)),
  CHECK ((evidence_kind = 'same_knowledge_point' AND current_entity_id = related_entity_id AND relation_id IS NULL AND relation_type IS NULL) OR (evidence_kind = 'approved_relation' AND relation_id IS NOT NULL AND relation_type IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS framework_continuity_target_idx ON framework_continuity_candidates(owner_id, framework_id, target_unit_id, direction, confidence);
