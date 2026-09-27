-- Current production presentation path: one approved Dashi goal plus a small
-- durable generation record, with artifacts stored privately in R2.
CREATE UNIQUE INDEX IF NOT EXISTS lesson_files_owner_id_unique_idx ON lesson_files(owner_id, id);
CREATE TABLE IF NOT EXISTS classroom_presentation_documents (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, notebook_id TEXT NOT NULL, lesson_file_id TEXT NOT NULL,
  title TEXT NOT NULL, theme TEXT NOT NULL, source_document_version INTEGER NOT NULL,
  source_document_json TEXT NOT NULL, dashi_goal_json TEXT, delivery TEXT NOT NULL DEFAULT 'native-dashi',
  storage_key TEXT NOT NULL, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL, checksum TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id, notebook_id) REFERENCES notebooks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, lesson_file_id) REFERENCES lesson_files(owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, idempotency_key), CHECK (delivery IN ('native-dashi', 'legacy-static')),
  CHECK (source_document_version >= 0), CHECK (byte_size >= 0)
);
CREATE INDEX IF NOT EXISTS classroom_presentation_documents_lesson_file_idx ON classroom_presentation_documents(owner_id, lesson_file_id, updated_at);
CREATE TABLE IF NOT EXISTS classroom_presentation_generations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, notebook_id TEXT NOT NULL, lesson_file_id TEXT NOT NULL,
  source_document_version INTEGER NOT NULL, source_document_json TEXT NOT NULL, lesson_title TEXT NOT NULL,
  subject TEXT NOT NULL, grade_level TEXT NOT NULL DEFAULT '', learner_profile TEXT NOT NULL DEFAULT '',
  lesson_duration_minutes INTEGER NOT NULL DEFAULT 40, storyboard_json TEXT, status TEXT NOT NULL,
  presentation_id TEXT, error_code TEXT, started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER,
  FOREIGN KEY (owner_id, notebook_id) REFERENCES notebooks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, lesson_file_id) REFERENCES lesson_files(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (presentation_id) REFERENCES classroom_presentation_documents(id) ON DELETE SET NULL,
  CHECK (status IN ('generating', 'ready', 'failed')), CHECK (source_document_version >= 0),
  CHECK (lesson_duration_minutes BETWEEN 10 AND 180), CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_presentation_generations_one_active_per_lesson_idx ON classroom_presentation_generations(owner_id, lesson_file_id) WHERE status = 'generating';
CREATE INDEX IF NOT EXISTS classroom_presentation_generations_latest_idx ON classroom_presentation_generations(owner_id, lesson_file_id, started_at);
