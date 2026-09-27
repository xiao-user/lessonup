-- Classroom feedback that needs a framework writeback becomes a durable
-- command. It is separate from feedback itself because the teacher's record
-- remains authoritative even when an Agent run later fails or is rejected.

CREATE TABLE IF NOT EXISTS semester_framework_writeback_intents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  framework_id TEXT NOT NULL,
  feedback_id TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (framework_id) REFERENCES semester_frameworks(id) ON DELETE CASCADE,
  FOREIGN KEY (feedback_id) REFERENCES lesson_class_feedback(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL,
  CHECK (state IN ('pending', 'claimed'))
);

CREATE INDEX IF NOT EXISTS semester_framework_writeback_intents_pending_idx
  ON semester_framework_writeback_intents(owner_id, framework_id, state, created_at);
