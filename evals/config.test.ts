import { describe, expect, it } from "vitest";

import { resolveEvalGraderConfig } from "./config.js";

describe("resolveEvalGraderConfig", () => {
  it("reuses the existing DeepSeek configuration by default", () => {
    expect(resolveEvalGraderConfig({
      DEEPSEEK_API_KEY: "deepseek-key",
      DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
      DEEPSEEK_PRO_MODEL: "deepseek-v4-pro",
    })).toEqual({
      apiKey: "deepseek-key",
      baseURL: "https://deepseek.example/v1",
      model: "deepseek-v4-pro",
    });
  });

  it("allows an explicitly independent grader to override DeepSeek", () => {
    expect(resolveEvalGraderConfig({
      DEEPSEEK_API_KEY: "agent-key",
      LESSONUP_EVAL_GRADER_API_KEY: "grader-key",
      LESSONUP_EVAL_GRADER_BASE_URL: "https://grader.example/v1",
      LESSONUP_EVAL_GRADER_MODEL: "grader-model",
    })).toEqual({
      apiKey: "grader-key",
      baseURL: "https://grader.example/v1",
      model: "grader-model",
    });
  });
});
