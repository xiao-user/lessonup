-- An approval card is proof that one specific proposal call passed preflight.
-- Without the proposing tool call id the browser could only match approvals to
-- activities by tool name, so a run that self-corrected after a rejected
-- preflight showed its earlier failed attempt as successful once the thread was
-- reloaded. Older approvals keep NULL and fall back to name-free attribution.

ALTER TABLE agent_approvals ADD COLUMN tool_call_id TEXT;
