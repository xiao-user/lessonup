export type AgentEvalPerformance = {
  durationMs: number;
  /** First browser-safe lifecycle event, including tool and approval activity. */
  firstSafeEventMs: number | null;
  /** First native assistant-stream event, before public text may arrive. */
  firstProviderEventMs: number | null;
  /** Legacy budget name: time to first public text delta. */
  firstOutputMs: number | null;
  modelRequests: number | null;
  toolCalls: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
};

/** Events the browser can render without exposing private provider internals. */
export function isSafePublicEvent(type: string) {
  return [
    "agent.started",
    "turn.started",
    "assistant.message.started",
    "message.delta",
    "tool.started",
    "tool.completed",
    "approval.required",
    "source.added",
  ].includes(type);
}

export type AgentEvalPerformanceBudget = {
  maxDurationMs: number;
  maxFirstOutputMs: number;
  maxModelRequests: number;
  maxToolCalls: number;
  maxInputTokens: number;
};

const budgetEnvironment = {
  maxDurationMs: "LESSONUP_EVAL_MAX_DURATION_MS",
  maxFirstOutputMs: "LESSONUP_EVAL_MAX_FIRST_OUTPUT_MS",
  maxModelRequests: "LESSONUP_EVAL_MAX_MODEL_REQUESTS",
  maxToolCalls: "LESSONUP_EVAL_MAX_TOOL_CALLS",
  maxInputTokens: "LESSONUP_EVAL_MAX_INPUT_TOKENS",
} as const;

function readPositiveInteger(
  environment: Record<string, string | undefined>,
  name: string,
) {
  const value = environment[name];
  if (!value?.trim()) throw new Error(`missing_required_environment:${name}`);
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(`invalid_positive_integer:${name}`);
  }
  return Number(value);
}

/**
 * Normal evals always report real measurements. Release evals opt in to a
 * budget, because an arbitrary default budget would create a false signal.
 */
export function resolvePerformanceBudget(
  environment: Record<string, string | undefined>,
) {
  if (environment.LESSONUP_EVAL_ENFORCE_PERFORMANCE_BUDGET !== "1") return null;
  return Object.fromEntries(
    Object.entries(budgetEnvironment).map(([key, name]) => [
      key,
      readPositiveInteger(environment, name),
    ]),
  ) as AgentEvalPerformanceBudget;
}

export function gradePerformance(
  metrics: AgentEvalPerformance,
  budget: AgentEvalPerformanceBudget | null,
) {
  if (!budget) return [];
  const failures: string[] = [];
  if (metrics.durationMs > budget.maxDurationMs) failures.push("performance_duration_exceeded");
  if (metrics.firstOutputMs === null || metrics.firstOutputMs > budget.maxFirstOutputMs) {
    failures.push("performance_first_output_exceeded");
  }
  if (metrics.modelRequests === null || metrics.modelRequests > budget.maxModelRequests) {
    failures.push("performance_model_requests_exceeded");
  }
  if (metrics.toolCalls > budget.maxToolCalls) failures.push("performance_tool_calls_exceeded");
  if (metrics.inputTokens === null || metrics.inputTokens > budget.maxInputTokens) {
    failures.push("performance_input_tokens_exceeded");
  }
  return failures;
}
