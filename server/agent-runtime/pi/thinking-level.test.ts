import { describe, expect, it } from "vitest";
import { resolveRunThinkingLevel, resolveTeacherThinkingLevel } from "./thinking-level.js";

describe("teacher thinking level", () => {
  it("accepts only GLM-supported efforts and defaults the rest to low", () => {
    expect(resolveTeacherThinkingLevel("low")).toBe("low");
    expect(resolveTeacherThinkingLevel("high")).toBe("high");
    expect(resolveTeacherThinkingLevel("max")).toBe("max");
    expect(resolveTeacherThinkingLevel("medium")).toBe("low");
    expect(resolveTeacherThinkingLevel(undefined)).toBe("low");
  });

  it("uses low on Fast chat and keeps the PromptBar value on Agent work", () => {
    expect(resolveRunThinkingLevel({ lane: "fast", requested: "max" })).toBe("low");
    expect(resolveRunThinkingLevel({ lane: "agent", requested: "max" })).toBe("max");
    expect(resolveRunThinkingLevel({ lane: "agent", requested: "high" })).toBe("high");
  });
});
