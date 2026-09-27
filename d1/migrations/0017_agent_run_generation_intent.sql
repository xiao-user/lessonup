-- The run itself records which durable generation command started it. A unique
-- nullable key lets D1 reject concurrent duplicate starts before messages are
-- written, while ordinary conversational runs continue to use NULL.

ALTER TABLE agent_runs ADD COLUMN generation_intent_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_generation_intent_unique_idx
  ON agent_runs(generation_intent_id);
