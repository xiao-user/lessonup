CREATE TABLE IF NOT EXISTS agent_runtime_session_messages (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, thread_id, branch_id, runtime, sequence_no),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES agent_branches(id) ON DELETE CASCADE,
  CHECK (runtime IN ('pi')),
  CHECK (sequence_no >= 1)
);

INSERT INTO agent_runtime_session_messages (
  owner_id, thread_id, branch_id, runtime, sequence_no, message_json, created_at
)
SELECT
  s.owner_id,
  s.thread_id,
  s.branch_id,
  s.runtime,
  CAST(j.key AS INTEGER) + 1,
  json(j.value),
  s.updated_at
FROM agent_runtime_sessions AS s, json_each(s.messages_json) AS j
WHERE json_valid(s.messages_json)
  AND json_array_length(s.messages_json) > 0;

UPDATE agent_runtime_sessions
SET messages_json = '[]'
WHERE (
  SELECT COUNT(*) FROM agent_runtime_session_messages AS m
  WHERE m.owner_id = agent_runtime_sessions.owner_id
    AND m.thread_id = agent_runtime_sessions.thread_id
    AND m.branch_id = agent_runtime_sessions.branch_id
    AND m.runtime = agent_runtime_sessions.runtime
) = json_array_length(messages_json);
