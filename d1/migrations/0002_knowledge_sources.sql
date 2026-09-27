-- Knowledge metadata is relational; private source files stay in R2. Vector
-- values are application-owned JSON so an eventual PostgreSQL adapter may map
-- them to pgvector without changing service contracts.

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  notebook_id TEXT,
  lesson_file_id TEXT,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_key TEXT,
  source_url TEXT,
  source_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued',
  index_version TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  upload_idempotency_key TEXT,
  attached_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  worker_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_file_id) REFERENCES lesson_files(id) ON DELETE CASCADE,
  CHECK (scope IN ('public', 'user', 'notebook', 'file')),
  CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'deleted')),
  CHECK (source_version > 0),
  CHECK (attempt_count >= 0),
  CHECK (max_attempts BETWEEN 1 AND 10)
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_owner_upload_key
  ON knowledge_sources(owner_id, upload_idempotency_key);
CREATE INDEX IF NOT EXISTS knowledge_sources_owner_scope_updated
  ON knowledge_sources(owner_id, scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_sources_claim_queue
  ON knowledge_sources(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS knowledge_sources_notebook_idx
  ON knowledge_sources(owner_id, notebook_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_sources_lesson_file_idx
  ON knowledge_sources(owner_id, lesson_file_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  notebook_id TEXT,
  lesson_file_id TEXT,
  scope TEXT NOT NULL,
  stable_chunk_id TEXT NOT NULL UNIQUE,
  section TEXT,
  page INTEGER,
  passage TEXT NOT NULL,
  adjacent_before TEXT,
  adjacent_after TEXT,
  embedding_json TEXT,
  index_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (scope IN ('public', 'user', 'notebook', 'file'))
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_source_idx
  ON knowledge_chunks(source_id, created_at);
CREATE INDEX IF NOT EXISTS knowledge_chunks_scope_idx
  ON knowledge_chunks(owner_id, scope, notebook_id, lesson_file_id);

CREATE TABLE IF NOT EXISTS knowledge_chunk_staging (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  notebook_id TEXT,
  lesson_file_id TEXT,
  scope TEXT NOT NULL,
  stable_chunk_id TEXT NOT NULL,
  section TEXT,
  page INTEGER,
  passage TEXT NOT NULL,
  adjacent_before TEXT,
  adjacent_after TEXT,
  embedding_json TEXT,
  index_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (scope IN ('public', 'user', 'notebook', 'file')),
  UNIQUE (source_id, worker_id, stable_chunk_id)
);

CREATE INDEX IF NOT EXISTS knowledge_chunk_staging_publish
  ON knowledge_chunk_staging(source_id, worker_id, created_at);

CREATE TABLE IF NOT EXISTS knowledge_audit_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source_id TEXT,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS knowledge_audit_events_source_idx
  ON knowledge_audit_events(source_id, created_at);
