import { describe, expect, it } from "vitest";

import { parseThreadStarters } from "./thread-starters.js";

describe("parseThreadStarters", () => {
  it("keeps unique model-generated suggestions", () => {
    expect(parseThreadStarters(JSON.stringify({
      suggestions: ["检查目标与评价的一致性", "检查目标与评价的一致性", "优化课堂问题链"],
    }))).toEqual(["检查目标与评价的一致性", "优化课堂问题链"]);
  });

  it("rejects non-JSON model output instead of showing canned prompts", () => {
    expect(() => parseThreadStarters("请检查教学目标")).toThrow();
  });

  it("accepts a fenced model-generated JSON object without replacing its content", () => {
    expect(parseThreadStarters([
      "```json",
      "{\"suggestions\":[\"检查重点难点是否对应目标\",\"优化课堂活动的层次\"]}",
      "```",
    ].join("\n"))).toEqual([
      "检查重点难点是否对应目标",
      "优化课堂活动的层次",
    ]);
  });
});
