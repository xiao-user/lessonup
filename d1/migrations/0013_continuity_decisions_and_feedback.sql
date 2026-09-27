CREATE TABLE IF NOT EXISTS framework_continuity_decisions (
  owner_id TEXT NOT NULL, framework_id TEXT NOT NULL, fingerprint TEXT NOT NULL, decision TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', target_unit_id TEXT, direction TEXT, current_entity_id TEXT, related_entity_id TEXT,
  related_unit_id TEXT, evidence_kind TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, framework_id, fingerprint), FOREIGN KEY (owner_id, framework_id) REFERENCES semester_frameworks(owner_id, id) ON DELETE CASCADE,
  CHECK (decision IN ('accepted', 'dismissed', 'candidate')), CHECK (direction IS NULL OR direction IN ('review', 'prepare')),
  CHECK (evidence_kind IS NULL OR evidence_kind IN ('same_knowledge_point', 'approved_relation', 'lexical_similarity'))
);
CREATE TABLE IF NOT EXISTS lesson_class_feedback (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, notebook_id TEXT NOT NULL, lesson_file_id TEXT NOT NULL,
  lesson_blueprint_id TEXT, semester_framework_id TEXT, kind TEXT NOT NULL, statement TEXT NOT NULL,
  related_entity_id TEXT, continuity_fingerprint TEXT, continuity_direction TEXT, continuity_outcome TEXT,
  writeback_status TEXT, evidence_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, notebook_id) REFERENCES notebooks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, lesson_file_id) REFERENCES lesson_files(owner_id, id) ON DELETE CASCADE,
  CHECK (kind IN ('observation', 'practice_gap', 'error_cause', 'continuity_outcome')), CHECK (length(trim(statement)) > 0),
  CHECK (continuity_direction IS NULL OR continuity_direction IN ('review', 'prepare')),
  CHECK (continuity_outcome IS NULL OR continuity_outcome IN ('worked', 'weak', 'skipped')),
  CHECK (writeback_status IS NULL OR writeback_status IN ('pending', 'applied', 'not_applicable')),
  CHECK (kind <> 'continuity_outcome' OR (continuity_fingerprint IS NOT NULL AND continuity_direction IS NOT NULL AND continuity_outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS lesson_class_feedback_file_idx ON lesson_class_feedback(owner_id, lesson_file_id, created_at);
