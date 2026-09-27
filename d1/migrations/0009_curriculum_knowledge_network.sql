-- Knowledge-point metadata belongs to the same versioned semantic release.
ALTER TABLE curriculum_node_semantics ADD COLUMN sequence_no INTEGER;
ALTER TABLE curriculum_node_semantics ADD COLUMN printed_pages TEXT;
ALTER TABLE curriculum_node_semantics ADD COLUMN recommended_period INTEGER;
ALTER TABLE curriculum_node_semantics ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS curriculum_node_semantics_sequence_idx ON curriculum_node_semantics(release_id, textbook_id, sequence_no, node_id);
CREATE INDEX IF NOT EXISTS curriculum_node_semantics_entity_occurrence_idx ON curriculum_node_semantics(release_id, semantic_entity_id, textbook_id, sequence_no);

CREATE TABLE IF NOT EXISTS curriculum_period_recommendations (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  textbook_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  period_no INTEGER NOT NULL,
  sequence_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  mapping_type TEXT NOT NULL,
  is_official INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  review_state TEXT NOT NULL DEFAULT 'draft',
  FOREIGN KEY (release_id) REFERENCES curriculum_semantic_releases(id) ON DELETE CASCADE,
  UNIQUE (release_id, id), UNIQUE (release_id, textbook_id, node_id, period_no),
  CHECK (period_no > 0), CHECK (sequence_no > 0), CHECK (is_official IN (0, 1)),
  CHECK (review_state IN ('draft', 'approved', 'rejected'))
);
CREATE TABLE IF NOT EXISTS curriculum_period_recommendation_points (
  release_id TEXT NOT NULL,
  period_recommendation_id TEXT NOT NULL,
  semantic_entity_id TEXT NOT NULL,
  sort_no INTEGER NOT NULL,
  PRIMARY KEY (release_id, period_recommendation_id, semantic_entity_id),
  FOREIGN KEY (release_id, period_recommendation_id) REFERENCES curriculum_period_recommendations(release_id, id) ON DELETE CASCADE,
  FOREIGN KEY (release_id, semantic_entity_id) REFERENCES curriculum_semantic_entity_revisions(release_id, semantic_entity_id) ON DELETE CASCADE,
  CHECK (sort_no > 0)
);
CREATE INDEX IF NOT EXISTS curriculum_period_recommendations_node_idx ON curriculum_period_recommendations(release_id, textbook_id, node_id, period_no);
CREATE INDEX IF NOT EXISTS curriculum_period_recommendation_points_entity_idx ON curriculum_period_recommendation_points(release_id, semantic_entity_id);
