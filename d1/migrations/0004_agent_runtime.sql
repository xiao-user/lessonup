CREATE TABLE IF NOT EXISTS agent_threads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  lesson_file_id TEXT,
  semester_framework_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  starter_suggestions_json TEXT,
  starter_suggestions_document_version INTEGER,
  starter_suggestions_resource_version INTEGER,
  archived_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_file_id) REFERENCES lesson_files(id) ON DELETE CASCADE,
  CHECK (resource_type IN ('lesson_file', 'semester_framework')),
  CHECK (status IN ('idle', 'running', 'awaiting_approval', 'failed')),
  CHECK ((resource_type = 'lesson_file' AND lesson_file_id IS NOT NULL AND semester_framework_id IS NULL)
      OR (resource_type = 'semester_framework' AND semester_framework_id IS NOT NULL AND lesson_file_id IS NULL))
);
CREATE INDEX IF NOT EXISTS agent_threads_resource_idx ON agent_threads(owner_id, resource_type, lesson_file_id, semester_framework_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_branches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  parent_branch_id TEXT,
  forked_from_message_id TEXT,
  label TEXT NOT NULL,
  pending_interaction_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_branch_id) REFERENCES agent_branches(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS agent_branches_thread_idx ON agent_branches(owner_id, thread_id, created_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]',
  session_cursor INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES agent_branches(id) ON DELETE CASCADE,
  CHECK (role IN ('user', 'assistant', 'system')),
  CHECK (status IN ('completed', 'streaming', 'cancelled', 'failed'))
);
CREATE INDEX IF NOT EXISTS agent_messages_branch_idx ON agent_messages(owner_id, thread_id, branch_id, created_at, id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_message_id TEXT,
  assistant_message_id TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  capability_plan_json TEXT,
  agent_definition_version TEXT,
  skill_versions_json TEXT NOT NULL DEFAULT '{}',
  attachment_source_ids_json TEXT NOT NULL DEFAULT '[]',
  token_usage_json TEXT NOT NULL DEFAULT '{}',
  provider_cost REAL,
  error TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  cancel_requested_at TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES agent_branches(id) ON DELETE CASCADE,
  CHECK (status IN ('queued', 'running', 'awaiting_approval', 'completed', 'cancelled', 'failed'))
);
CREATE INDEX IF NOT EXISTS agent_runs_branch_idx ON agent_runs(owner_id, thread_id, branch_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_recovery_idx ON agent_runs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_events_run_idx ON agent_events(owner_id, run_id, created_at, id);

CREATE TABLE IF NOT EXISTS agent_approvals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  assistant_message_id TEXT,
  state TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  encrypted_run_state TEXT NOT NULL,
  agent_definition_version TEXT NOT NULL,
  resource_type TEXT,
  patch_kind TEXT,
  lesson_file_id TEXT,
  semester_framework_id TEXT,
  base_resource_version INTEGER,
  document_version INTEGER,
  continuation_status TEXT NOT NULL DEFAULT 'pending',
  continuation_lease_token TEXT,
  continuation_lease_expires_at TEXT,
  continuation_attempt_count INTEGER NOT NULL DEFAULT 0,
  continuation_error TEXT,
  continuation_message_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES agent_branches(id) ON DELETE CASCADE,
  CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  CHECK (continuation_status IN ('pending', 'ready', 'running', 'completed'))
);
CREATE INDEX IF NOT EXISTS agent_approvals_branch_idx ON agent_approvals(owner_id, thread_id, branch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_runtime_sessions (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  revision INTEGER NOT NULL,
  messages_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, thread_id, branch_id, runtime),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES agent_branches(id) ON DELETE CASCADE,
  CHECK (runtime IN ('pi')),
  CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS agent_session_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  item_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES agent_branches(id) ON DELETE CASCADE,
  UNIQUE (owner_id, thread_id, branch_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS agent_session_items_branch_idx ON agent_session_items(owner_id, thread_id, branch_id, sequence_no);

-- A completed append key records an exact immutable payload. This lets an
-- interrupted Agent retry safely without duplicating protocol items.
CREATE TABLE IF NOT EXISTS agent_session_append_batches (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, thread_id, branch_id, idempotency_key),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES agent_branches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_thread_memories (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  summary_cursor INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, thread_id, branch_id),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES agent_branches(id) ON DELETE CASCADE,
  CHECK (summary_cursor >= 0)
);

-- Evidence stores the exact public source reference observed by an Agent run.
-- Keep this generic instead of coupling it to a vector engine or provider.
CREATE TABLE IF NOT EXISTS agent_run_evidence (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  source_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, run_id, kind, evidence_key),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_run_evidence_run_idx
  ON agent_run_evidence(owner_id, run_id, created_at);
