type FailureContext = {
  source: "run" | "start" | "approval";
  runId?: string;
  threadId?: string;
  approvalId?: string;
};

/** Codes `publicAgentError` falls back to when it recognised nothing. */
const fallbackCodes = new Set(["agent_run_failed", "approval_resume_failed"]);
const MAX_MESSAGE_CHARACTERS = 500;
const MAX_STACK_LINES = 8;

function describe(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error).slice(0, MAX_MESSAGE_CHARACTERS) };
  return {
    name: error.name,
    message: error.message.slice(0, MAX_MESSAGE_CHARACTERS),
    ...(depth === 0 && error.stack ? { stack: error.stack.split("\n").slice(0, MAX_STACK_LINES).join("\n") } : {}),
    ...(error.cause !== undefined && depth < 2 ? { cause: describe(error.cause, depth + 1) } : {}),
  };
}

/**
 * Records why an Agent run failed. The browser only ever receives the public
 * error code, so without this the real cause of a generic `agent_run_failed`
 * is unrecoverable. Only opaque ids, the code and the error itself are logged:
 * never the teacher's message or any model output.
 *
 * With `onlyUnexpected`, an error that mapped to a specific public code (an
 * ordinary validation outcome such as `active_run_exists`) is not logged.
 */
export function logAgentFailure(
  context: FailureContext,
  code: string,
  error: unknown,
  options: { onlyUnexpected?: boolean } = {},
) {
  if (options.onlyUnexpected && !fallbackCodes.has(code)) return;
  console.error("Agent failure", JSON.stringify({ ...context, code, error: describe(error) }));
}
