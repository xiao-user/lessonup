-- A thread is the coordination atom exposed by the assistant UI.  Branches
-- isolate transcript history, but they must not create two simultaneous runs
-- that both mutate the same thread-level availability state.
--
-- Repair any legacy duplicate active rows before installing the invariant.
-- The newest run remains active; older rows become durable failed attempts.
UPDATE agent_runs
SET status = 'failed',
    error = 'superseded_active_run',
    completed_at = COALESCE(completed_at, started_at),
    lease_token = NULL,
    lease_expires_at = NULL
WHERE status IN ('queued', 'running', 'awaiting_approval')
  AND EXISTS (
    SELECT 1
    FROM agent_runs AS newer
    WHERE newer.owner_id = agent_runs.owner_id
      AND newer.thread_id = agent_runs.thread_id
      AND newer.status IN ('queued', 'running', 'awaiting_approval')
      AND (
        newer.started_at > agent_runs.started_at
        OR (newer.started_at = agent_runs.started_at AND newer.id > agent_runs.id)
      )
  );

UPDATE agent_messages
SET status = 'failed', error = 'superseded_active_run'
WHERE id IN (
  SELECT assistant_message_id
  FROM agent_runs
  WHERE status = 'failed'
    AND error = 'superseded_active_run'
    AND assistant_message_id IS NOT NULL
);

-- Recompute the cached presentation status from the repaired aggregate. The
-- thread row is a projection; it must never claim that a superseded run is
-- still active.
UPDATE agent_threads
SET status = CASE
  WHEN EXISTS (
    SELECT 1 FROM agent_runs
    WHERE agent_runs.owner_id = agent_threads.owner_id
      AND agent_runs.thread_id = agent_threads.id
      AND agent_runs.status = 'awaiting_approval'
  ) THEN 'awaiting_approval'
  WHEN EXISTS (
    SELECT 1 FROM agent_runs
    WHERE agent_runs.owner_id = agent_threads.owner_id
      AND agent_runs.thread_id = agent_threads.id
      AND agent_runs.status IN ('queued', 'running')
  ) THEN 'running'
  ELSE 'idle'
END;

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_thread_idx
  ON agent_runs(owner_id, thread_id)
  WHERE status IN ('queued', 'running', 'awaiting_approval');

-- Network retries identify the accepted command rather than guessing from
-- message content. The fingerprint rejects accidental key reuse with a
-- different payload.
ALTER TABLE agent_runs ADD COLUMN client_command_id TEXT;
ALTER TABLE agent_runs ADD COLUMN command_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_client_command_unique_idx
  ON agent_runs(owner_id, thread_id, client_command_id)
  WHERE client_command_id IS NOT NULL;

-- created_at is useful metadata, not a journal cursor: multiple events can be
-- emitted in the same millisecond and UUID ordering is intentionally random.
ALTER TABLE agent_events ADD COLUMN sequence_no INTEGER;

UPDATE agent_events
SET sequence_no = (
  SELECT COUNT(*)
  FROM agent_events AS preceding
  WHERE preceding.owner_id = agent_events.owner_id
    AND preceding.run_id = agent_events.run_id
    AND (
      preceding.created_at < agent_events.created_at
      OR (preceding.created_at = agent_events.created_at AND preceding.id <= agent_events.id)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_events_run_sequence_idx
  ON agent_events(owner_id, run_id, sequence_no);
