-- Decisions are append-only judgments; evidence cards keep their locatable source.
CREATE TABLE lesson_evidence_cards (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, notebook_id TEXT NOT NULL, lesson_file_id TEXT NOT NULL,
  kind TEXT NOT NULL, level TEXT NOT NULL, pii_level TEXT NOT NULL,
  record_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(owner_id, id),
  FOREIGN KEY(owner_id, lesson_file_id) REFERENCES lesson_files(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, notebook_id) REFERENCES notebooks(owner_id, id) ON DELETE CASCADE,
  CHECK(level IN ('primary', 'first_hand_summary', 'secondary', 'synthetic')),
  CHECK(pii_level IN ('none', 'teacher', 'student'))
);
CREATE INDEX lesson_evidence_cards_file_idx ON lesson_evidence_cards(owner_id, lesson_file_id, created_at DESC);

CREATE TABLE lesson_decisions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, notebook_id TEXT NOT NULL, lesson_file_id TEXT NOT NULL,
  decision_type TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
  chosen_option_id TEXT, confidence REAL, review_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
  UNIQUE(owner_id, id),
  FOREIGN KEY(owner_id, lesson_file_id) REFERENCES lesson_files(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, notebook_id) REFERENCES notebooks(owner_id, id) ON DELETE CASCADE,
  CHECK(version >= 0),
  CHECK(status IN ('draft', 'proposed', 'insufficient_evidence', 'teacher_confirmed', 'teacher_rejected',
    'no_change', 'implemented', 'reviewed', 'superseded'))
);
CREATE INDEX lesson_decisions_file_idx ON lesson_decisions(owner_id, lesson_file_id, updated_at DESC, id DESC);
CREATE INDEX lesson_decisions_status_idx ON lesson_decisions(owner_id, lesson_file_id, status, updated_at DESC);

CREATE TABLE lesson_decision_versions (
  owner_id TEXT NOT NULL, decision_id TEXT NOT NULL, version INTEGER NOT NULL,
  record_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, decision_id, version),
  FOREIGN KEY(owner_id, decision_id) REFERENCES lesson_decisions(owner_id, id) ON DELETE CASCADE
);
