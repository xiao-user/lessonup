import { describe, expect, it } from "vitest";
import { gradeFrontendPerformance, gradePerformance, isSafePublicEvent, resolveFrontendPerformanceBudget, resolvePerformanceBudget } from "./performance.js";

const environment = {
  LESSONUP_EVAL_ENFORCE_PERFORMANCE_BUDGET: "1",
  LESSONUP_EVAL_MAX_DURATION_MS: "30000",
  LESSONUP_EVAL_MAX_FIRST_OUTPUT_MS: "8000",
  LESSONUP_EVAL_MAX_MODEL_REQUESTS: "4",
  LESSONUP_EVAL_MAX_TOOL_CALLS: "6",
  LESSONUP_EVAL_MAX_INPUT_TOKENS: "24000",
};

describe("browser performance budget", () => {
  it("requires explicit measured budgets and fails missing or over-budget observations", () => {
    expect(resolveFrontendPerformanceBudget({})).toBeNull();
    expect(() => resolveFrontendPerformanceBudget({ LESSONUP_UI_ENFORCE_BUDGET: "1" })).toThrow("LESSONUP_UI_MAX_INPUT_MS");
    const budget = resolveFrontendPerformanceBudget({ LESSONUP_UI_ENFORCE_BUDGET: "1", LESSONUP_UI_MAX_INPUT_MS: "1000", LESSONUP_UI_MAX_BLOCKING_MS: "1000", LESSONUP_UI_MAX_FRAME_GAP_MS: "500" });
    expect(gradeFrontendPerformance({ inputMs: 500, streaming: { blockingTimeMs: 400, maximumFrameGapMs: 200 } }, budget)).toEqual([]);
    expect(gradeFrontendPerformance({ inputMs: 1500, streaming: { blockingTimeMs: 1400, maximumFrameGapMs: null } }, budget)).toHaveLength(3);
    expect(gradeFrontendPerformance({ inputMs: NaN, streaming: { blockingTimeMs: Infinity, maximumFrameGapMs: NaN } }, budget)).toHaveLength(3);
  });
});

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
      firstSafeEventMs: null,
      firstProviderEventMs: null,
      firstOutputMs: null,
      modelRequests: 5,
      toolCalls: 7,
      inputTokens: null,
      cachedInputTokens: null,
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
      firstSafeEventMs: 500,
      firstProviderEventMs: 700,
      firstOutputMs: 8000,
      modelRequests: 4,
      toolCalls: 6,
      inputTokens: 24000,
      cachedInputTokens: 12000,
    }, budget)).toEqual([]);
  });

  it("recognizes browser-safe milestones without mistaking internal events for progress", () => {
    expect(isSafePublicEvent("agent.started")).toBe(true);
    expect(isSafePublicEvent("tool.started")).toBe(true);
    expect(isSafePublicEvent("message.delta")).toBe(true);
    expect(isSafePublicEvent("agent.private_reasoning")).toBe(false);
  });
});
