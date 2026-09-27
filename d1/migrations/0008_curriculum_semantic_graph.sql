-- Versioned public curriculum semantic graph. Publication and graph traversal
-- are repository responsibilities so this schema stays portable to Postgres.
CREATE TABLE IF NOT EXISTS curriculum_semantic_releases (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  catalog_generation_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  volume TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  source_manifest_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  published_at TEXT,
  retired_at TEXT,
  CHECK (schema_version > 0),
  CHECK (status IN ('draft', 'published', 'retired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS curriculum_semantic_one_published_scope_idx
  ON curriculum_semantic_releases(scope_key) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS curriculum_semantic_entities (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (subject, stage, kind, canonical_key),
  CHECK (kind IN ('knowledge_point', 'knowledge', 'method', 'strategy', 'capability', 'learning_outcome', 'misconception'))
);
CREATE TABLE IF NOT EXISTS curriculum_semantic_entity_revisions (
  release_id TEXT NOT NULL,
  semantic_entity_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  definition TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  external_id TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  embedding_json TEXT,
  embedding_model TEXT,
  confidence REAL NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'draft',
  PRIMARY KEY (release_id, semantic_entity_id),
  UNIQUE (release_id, external_id),
  FOREIGN KEY (release_id) REFERENCES curriculum_semantic_releases(id) ON DELETE CASCADE,
  FOREIGN KEY (semantic_entity_id) REFERENCES curriculum_semantic_entities(id) ON DELETE RESTRICT,
  CHECK (confidence BETWEEN 0 AND 1),
  CHECK (review_state IN ('draft', 'approved', 'rejected'))
);
CREATE TABLE IF NOT EXISTS curriculum_semantic_relations (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  grade_from TEXT,
  grade_to TEXT,
  strength REAL NOT NULL DEFAULT 1,
  confidence REAL NOT NULL,
  rationale TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'draft',
  FOREIGN KEY (release_id) REFERENCES curriculum_semantic_releases(id) ON DELETE CASCADE,
  FOREIGN KEY (from_entity_id) REFERENCES curriculum_semantic_entities(id) ON DELETE RESTRICT,
  FOREIGN KEY (to_entity_id) REFERENCES curriculum_semantic_entities(id) ON DELETE RESTRICT,
  UNIQUE (release_id, id),
  CHECK (from_entity_id <> to_entity_id),
  CHECK (relation_type IN ('part_of', 'prerequisite', 'supports', 'develops_into', 'contrasts_with', 'often_confused_with', 'transfers_to')),
  CHECK (strength BETWEEN 0 AND 1), CHECK (confidence BETWEEN 0 AND 1),
  CHECK (review_state IN ('draft', 'approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS curriculum_semantic_relations_from_idx ON curriculum_semantic_relations(release_id, from_entity_id, relation_type);
CREATE INDEX IF NOT EXISTS curriculum_semantic_relations_to_idx ON curriculum_semantic_relations(release_id, to_entity_id, relation_type);

CREATE TABLE IF NOT EXISTS curriculum_node_semantics (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  textbook_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  semantic_entity_id TEXT NOT NULL,
  instructional_role TEXT NOT NULL,
  expected_depth INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL,
  rationale TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'draft',
  FOREIGN KEY (release_id) REFERENCES curriculum_semantic_releases(id) ON DELETE CASCADE,
  FOREIGN KEY (semantic_entity_id) REFERENCES curriculum_semantic_entities(id) ON DELETE RESTRICT,
  UNIQUE (release_id, id),
  UNIQUE (release_id, textbook_id, node_id, semantic_entity_id, instructional_role),
  CHECK (instructional_role IN ('occurs_in', 'introduces', 'develops', 'reinforces', 'applies', 'transfers', 'assesses', 'background')),
  CHECK (expected_depth BETWEEN 0 AND 5), CHECK (priority BETWEEN 1 AND 10),
  CHECK (confidence BETWEEN 0 AND 1), CHECK (review_state IN ('draft', 'approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS curriculum_node_semantics_node_idx ON curriculum_node_semantics(textbook_id, node_id, release_id);

CREATE TABLE IF NOT EXISTS curriculum_semantic_sources (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  authority TEXT NOT NULL,
  locator TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (release_id) REFERENCES curriculum_semantic_releases(id) ON DELETE CASCADE,
  UNIQUE (release_id, id),
  UNIQUE (release_id, source_ref_id)
);
CREATE TABLE IF NOT EXISTS curriculum_semantic_entity_sources (
  release_id TEXT NOT NULL, semantic_entity_id TEXT NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY (release_id, semantic_entity_id, source_id),
  FOREIGN KEY (release_id, semantic_entity_id) REFERENCES curriculum_semantic_entity_revisions(release_id, semantic_entity_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES curriculum_semantic_sources(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS curriculum_semantic_relation_sources (
  release_id TEXT NOT NULL, relation_id TEXT NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY (release_id, relation_id, source_id),
  FOREIGN KEY (release_id, relation_id) REFERENCES curriculum_semantic_relations(release_id, id) ON DELETE CASCADE,
  FOREIGN KEY (release_id, source_id) REFERENCES curriculum_semantic_sources(release_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS curriculum_node_semantic_sources (
  release_id TEXT NOT NULL, node_semantic_id TEXT NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY (release_id, node_semantic_id, source_id),
  FOREIGN KEY (release_id, node_semantic_id) REFERENCES curriculum_node_semantics(release_id, id) ON DELETE CASCADE,
  FOREIGN KEY (release_id, source_id) REFERENCES curriculum_semantic_sources(release_id, id) ON DELETE CASCADE
);
