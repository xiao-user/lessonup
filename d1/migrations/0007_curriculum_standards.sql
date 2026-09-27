-- Public curriculum standards are platform data, deliberately separate from
-- teacher-owned knowledge_sources. JSON columns preserve the few collection
-- fields in a form that maps cleanly to Postgres JSONB on a future migration.
CREATE TABLE IF NOT EXISTS curriculum_standard_releases (
  id TEXT PRIMARY KEY,
  series_key TEXT NOT NULL,
  release_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  version_label TEXT NOT NULL,
  authority TEXT,
  issued_year INTEGER,
  expected_document_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('draft', 'published', 'retired')),
  CHECK (expected_document_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS curriculum_standard_one_published_series_idx
  ON curriculum_standard_releases(series_key) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS curriculum_standard_documents (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  title TEXT NOT NULL,
  subject TEXT,
  document_kind TEXT NOT NULL,
  stage_scope_json TEXT NOT NULL DEFAULT '[]',
  grade_scope_json TEXT NOT NULL DEFAULT '[]',
  standard_code TEXT,
  source_url TEXT,
  file_sha256 TEXT NOT NULL,
  index_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (release_id, filename),
  FOREIGN KEY (release_id) REFERENCES curriculum_standard_releases(id) ON DELETE CASCADE,
  CHECK (document_kind IN ('curriculum_standard', 'curriculum_plan'))
);
CREATE INDEX IF NOT EXISTS curriculum_standard_documents_scope_idx
  ON curriculum_standard_documents(release_id, subject, document_kind);

CREATE TABLE IF NOT EXISTS curriculum_standard_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  stable_chunk_id TEXT NOT NULL,
  page INTEGER,
  page_end INTEGER,
  passage TEXT NOT NULL,
  section TEXT,
  curriculum_stage TEXT,
  grade_start INTEGER,
  grade_end INTEGER,
  curriculum_domain TEXT,
  embedding_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (document_id, stable_chunk_id),
  FOREIGN KEY (document_id) REFERENCES curriculum_standard_documents(id) ON DELETE CASCADE,
  CHECK (page IS NULL OR page > 0),
  CHECK (page_end IS NULL OR page_end > 0),
  CHECK (grade_start IS NULL OR grade_start BETWEEN 1 AND 12),
  CHECK (grade_end IS NULL OR grade_end BETWEEN 1 AND 12),
  CHECK (grade_start IS NULL OR grade_end IS NULL OR grade_start <= grade_end)
);
CREATE INDEX IF NOT EXISTS curriculum_standard_chunks_document_idx
  ON curriculum_standard_chunks(document_id, created_at, stable_chunk_id);
