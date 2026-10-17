-- Aggregate decision telemetry only: no free text, no student identifiers.
CREATE TABLE lesson_decision_events (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, lesson_file_id TEXT NOT NULL,
  event_type TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(owner_id, id),
  FOREIGN KEY(owner_id, lesson_file_id) REFERENCES lesson_files(owner_id, id) ON DELETE CASCADE,
  CHECK(event_type IN ('decision_viewed', 'evidence_opened', 'option_compared', 'proposal_requested',
    'decision_confirmed', 'decision_rejected', 'no_change_confirmed', 'implementation_recorded', 'review_recorded'))
);
CREATE INDEX lesson_decision_events_file_idx ON lesson_decision_events(owner_id, lesson_file_id, created_at DESC);
