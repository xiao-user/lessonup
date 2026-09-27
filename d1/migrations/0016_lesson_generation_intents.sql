-- A framework-generated lesson must not rely on a React-only prompt. This
-- durable command is claimed by exactly one Pi run, preserving the teacher's
-- request across navigation, refresh, and transient client disconnection.
-- The schema uses only portable text identifiers and explicit timestamps.

CREATE TABLE IF NOT EXISTS lesson_generation_intents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lesson_file_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_file_id) REFERENCES lesson_files(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL,
  UNIQUE (owner_id, lesson_file_id),
  CHECK (state IN ('pending', 'claimed'))
);

CREATE INDEX IF NOT EXISTS lesson_generation_intents_pending_idx
  ON lesson_generation_intents(owner_id, lesson_file_id, state);
