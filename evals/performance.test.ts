import { describe, expect, it } from "vitest";
import { gradePerformance, resolvePerformanceBudget } from "./performance.js";

const environment = {
  LESSONUP_EVAL_ENFORCE_PERFORMANCE_BUDGET: "1",
  LESSONUP_EVAL_MAX_DURATION_MS: "30000",
  LESSONUP_EVAL_MAX_FIRST_OUTPUT_MS: "8000",
  LESSONUP_EVAL_MAX_MODEL_REQUESTS: "4",
  LESSONUP_EVAL_MAX_TOOL_CALLS: "6",
  LESSONUP_EVAL_MAX_INPUT_TOKENS: "24000",
};

describe("agent eval performance budget", () => {
  it("records without enforcing a budget during ordinary diagnostic evals", () => {
    expect(resolvePerformanceBudget({})).toBeNull();
  });

  it("requires every release threshold instead of inventing one", () => {
    expect(() => resolvePerformanceBudget({
      LESSONUP_EVAL_ENFORCE_PERFORMANCE_BUDGET: "1",
    })).toThrow("missing_required_environment:LESSONUP_EVAL_MAX_DURATION_MS");
  });

  it("fails an over-budget or unobservable release run", () => {
    const budget = resolvePerformanceBudget(environment)!;
    expect(gradePerformance({
      durationMs: 30001,
      firstOutputMs: null,
      modelRequests: 5,
      toolCalls: 7,
      inputTokens: null,
    }, budget)).toEqual([
      "performance_duration_exceeded",
      "performance_first_output_exceeded",
      "performance_model_requests_exceeded",
      "performance_tool_calls_exceeded",
      "performance_input_tokens_exceeded",
    ]);
  });

  it("accepts a measurement that stays within an explicit budget", () => {
    const budget = resolvePerformanceBudget(environment)!;
    expect(gradePerformance({
      durationMs: 30000,
      firstOutputMs: 8000,
      modelRequests: 4,
      toolCalls: 6,
      inputTokens: 24000,
    }, budget)).toEqual([]);
  });
});
