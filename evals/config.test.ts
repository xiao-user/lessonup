import { describe, expect, it } from "vitest";

import { resolveEvalGraderConfig } from "./config.js";

describe("resolveEvalGraderConfig", () => {
  it("reuses the generic model configuration by default", () => {
    expect(resolveEvalGraderConfig({
      MODEL_API_KEY: "model-key",
      MODEL_BASE_URL: "https://gateway.example/v1",
      MODEL_ID: "model-a",
      MODEL_API: "openai-responses",
      MODEL_CONTEXT_WINDOW: "100000",
      MODEL_MAX_TOKENS: "8000",
    })).toEqual({
      apiKey: "model-key",
      baseURL: "https://gateway.example/v1",
      model: "model-a",
      api: "openai-responses",
      contextWindow: 100000,
      maxTokens: 8000,
    });
  });

  it("allows an explicitly independent grader to override the application model", () => {
    expect(resolveEvalGraderConfig({
      MODEL_API_KEY: "agent-key",
      MODEL_BASE_URL: "https://gateway.example/v1",
      MODEL_ID: "model-a",
      LESSONUP_EVAL_GRADER_API_KEY: "grader-key",
      LESSONUP_EVAL_GRADER_BASE_URL: "https://grader.example/v1",
      LESSONUP_EVAL_GRADER_MODEL: "grader-model",
      LESSONUP_EVAL_GRADER_API: "openai-completions",
      LESSONUP_EVAL_GRADER_CONTEXT_WINDOW: "200000",
      LESSONUP_EVAL_GRADER_MAX_TOKENS: "12000",
    })).toEqual({
      apiKey: "grader-key",
      baseURL: "https://grader.example/v1",
      model: "grader-model",
      api: "openai-completions",
      contextWindow: 200000,
      maxTokens: 12000,
    });
  });
});
