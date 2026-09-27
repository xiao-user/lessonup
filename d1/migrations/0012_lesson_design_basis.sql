CREATE TABLE IF NOT EXISTS lesson_design_bases (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, notebook_id TEXT NOT NULL, lesson_file_id TEXT NOT NULL,
  framework_id TEXT, semester_unit_id TEXT, lesson_blueprint_id TEXT, catalog_release_id TEXT, textbook_id TEXT,
  curriculum_node_id TEXT, semantic_release_id TEXT, source_framework_version INTEGER, source_blueprint_version INTEGER,
  learner_context_json TEXT NOT NULL DEFAULT '{}', teacher_notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, lesson_file_id) REFERENCES lesson_files(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, framework_id) REFERENCES semester_frameworks(owner_id, id) ON DELETE RESTRICT,
  UNIQUE (owner_id, id), UNIQUE (owner_id, lesson_file_id), CHECK (status IN ('draft', 'confirmed', 'stale')),
  CHECK (version >= 0), CHECK (source_framework_version IS NULL OR source_framework_version >= 0), CHECK (source_blueprint_version IS NULL OR source_blueprint_version >= 0)
);
CREATE TABLE IF NOT EXISTS lesson_design_basis_entries (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, basis_id TEXT NOT NULL, kind TEXT NOT NULL,
  semantic_entity_id TEXT, semantic_entity_name TEXT, related_semantic_entity_id TEXT, related_semantic_entity_name TEXT,
  related_curriculum_node_id TEXT, related_curriculum_node_title TEXT, statement TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]', decision TEXT NOT NULL DEFAULT 'accepted', teacher_confirmed INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'teacher', sort_no INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, basis_id) REFERENCES lesson_design_bases(owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, basis_id, id), UNIQUE (owner_id, basis_id, sort_no), CHECK (length(trim(statement)) > 0),
  CHECK (kind IN ('knowledge_point', 'review', 'prepare', 'student_difficulty', 'assessment_evidence', 'teaching_decision')),
  CHECK (decision IN ('accepted', 'dismissed')), CHECK (teacher_confirmed IN (0, 1)), CHECK (origin IN ('platform', 'teacher', 'agent', 'import')),
  CHECK (sort_no > 0), CHECK (version >= 0)
);
CREATE TABLE IF NOT EXISTS lesson_design_basis_versions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, basis_id TEXT NOT NULL, basis_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL, actor TEXT NOT NULL, run_id TEXT, approval_id TEXT, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, basis_id) REFERENCES lesson_design_bases(owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, basis_id, basis_version), UNIQUE (owner_id, idempotency_key),
  CHECK (basis_version >= 0), CHECK (actor IN ('manual', 'agent', 'import'))
);
CREATE INDEX IF NOT EXISTS lesson_design_basis_entries_basis_idx ON lesson_design_basis_entries(owner_id, basis_id, sort_no);
