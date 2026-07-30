import { describe, expect, it } from "vitest";

import { enforceRequiredCapabilities } from "./capability-router.js";

describe("enforceRequiredCapabilities", () => {
  it("keeps document writes available when the model router omits them", () => {
    const plan = enforceRequiredCapabilities("请替换教学目标第一条并提交修改建议", {
      skillIds: ["lesson-objective-review"],
      toolGroups: ["document-read"],
      mcpServers: [],
      specialistAgents: ["curriculum-analysis"],
    });

    expect(plan.toolGroups).toEqual(["document-read", "document-write"]);
  });

  it("does not grant write access for read-only questions", () => {
    const plan = enforceRequiredCapabilities("概括当前教学目标", {
      skillIds: [],
      toolGroups: ["document-read"],
      mcpServers: [],
      specialistAgents: [],
    });

    expect(plan.toolGroups).toEqual(["document-read"]);
  });
});
