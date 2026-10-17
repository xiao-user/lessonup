-- Observations are immutable; inquiry decisions have an append-only history.
CREATE TABLE learning_evidence (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, notebook_id TEXT NOT NULL, lesson_file_id TEXT NOT NULL,
  inquiry_id TEXT, observed_at TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
  UNIQUE(owner_id, id),
  FOREIGN KEY(owner_id, lesson_file_id) REFERENCES lesson_files(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, notebook_id) REFERENCES notebooks(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX learning_evidence_file_idx ON learning_evidence(owner_id, lesson_file_id, observed_at DESC, id DESC);
CREATE TABLE learning_inquiries (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, notebook_id TEXT NOT NULL, lesson_file_id TEXT NOT NULL,
  baseline_evidence_id TEXT NOT NULL, source_run_id TEXT, state TEXT NOT NULL, version INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
  UNIQUE(owner_id, id),
  FOREIGN KEY(owner_id, lesson_file_id) REFERENCES lesson_files(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, notebook_id) REFERENCES notebooks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, baseline_evidence_id) REFERENCES learning_evidence(owner_id, id),
  CHECK(state IN ('proposed', 'adopted', 'implemented', 'reviewed', 'dismissed')), CHECK(version >= 0)
);
CREATE INDEX learning_inquiries_file_idx ON learning_inquiries(owner_id, lesson_file_id, updated_at DESC, id DESC);
CREATE TABLE learning_inquiry_versions (
  owner_id TEXT NOT NULL, inquiry_id TEXT NOT NULL, version INTEGER NOT NULL,
  record_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, inquiry_id, version),
  FOREIGN KEY(owner_id, inquiry_id) REFERENCES learning_inquiries(owner_id, id) ON DELETE CASCADE
);
