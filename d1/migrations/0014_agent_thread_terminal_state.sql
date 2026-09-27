-- A thread models current availability, not the outcome of its latest run.
-- Runs and assistant messages retain their failed terminal states for history
-- and explicit retry. Existing failed threads are safely reopened as idle.
UPDATE agent_threads
SET status = 'idle'
WHERE status = 'failed';
