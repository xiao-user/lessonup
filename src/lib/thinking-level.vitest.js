import { describe, expect, it } from "vitest";
import { parseThinkingLevel, thinkingLevelLabel } from "./thinking-level.js";

describe("thinking level", () => {
  it("keeps only the teacher-facing GLM efforts", () => {
    expect(parseThinkingLevel("low")).toBe("low");
    expect(parseThinkingLevel("high")).toBe("high");
    expect(parseThinkingLevel("max")).toBe("max");
    expect(parseThinkingLevel("medium")).toBe("low");
    expect(parseThinkingLevel(null)).toBe("low");
  });

  it("labels the composer control in Chinese", () => {
    expect(thinkingLevelLabel("low")).toBe("轻度");
    expect(thinkingLevelLabel("high")).toBe("增强");
    expect(thinkingLevelLabel("max")).toBe("深度");
  });
});
