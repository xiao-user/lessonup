-- Immutable document history and request replay records. Both tables use
-- opaque JSON payloads owned by the application rather than SQLite JSON APIs.

CREATE TABLE IF NOT EXISTS lesson_file_versions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lesson_file_id TEXT NOT NULL,
  document_version INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  actor TEXT NOT NULL,
  run_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_file_id) REFERENCES lesson_files(id) ON DELETE CASCADE,
  CHECK (document_version >= 0),
  CHECK (page_count > 0),
  CHECK (actor IN ('manual', 'agent', 'undo', 'import')),
  UNIQUE (owner_id, idempotency_key),
  UNIQUE (owner_id, lesson_file_id, document_version)
);

CREATE INDEX IF NOT EXISTS lesson_file_versions_file_idx
  ON lesson_file_versions(owner_id, lesson_file_id, document_version DESC);

CREATE TABLE IF NOT EXISTS operation_idempotency (
  owner_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, operation, idempotency_key),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
