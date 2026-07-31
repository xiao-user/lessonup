import { describe, expect, it } from "vitest";

import {
  deterministicCapabilityPlan,
  enforceRequiredCapabilities,
  requiresDocumentWrite,
  routeCapabilities,
} from "./capability-router.js";

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

  it("keeps the approval-gated write tool available for read-only questions", () => {
    const plan = enforceRequiredCapabilities("概括当前教学目标", {
      skillIds: [],
      toolGroups: ["document-read"],
      mcpServers: [],
      specialistAgents: [],
    });

    expect(plan.toolGroups).toEqual(["document-read", "document-write"]);
  });

  it("keeps broad optimization intent consultative without hiding the standard write tool", () => {
    expect(requiresDocumentWrite("你认为现在还有哪些需要调整和优化？")).toBe(false);
    const plan = enforceRequiredCapabilities("你认为现在还有哪些需要调整和优化？", {
      skillIds: ["lesson-critique"],
      toolGroups: ["document-read", "document-write"],
      mcpServers: [],
      specialistAgents: ["critic"],
    });
    expect(plan.toolGroups).toEqual(["document-read", "document-write"]);
  });

  it("recognizes an explicit optimization command as write intent", () => {
    expect(requiresDocumentWrite("请优化教学目标并提交修改")).toBe(true);
    expect(requiresDocumentWrite("按照这些内容重新更改教学重点难点")).toBe(true);
  });

  it("routes an explicit document change without requiring a model decision", () => {
    expect(deterministicCapabilityPlan("按照这些内容重新更改教学重点难点")).toMatchObject({
      skillIds: ["lesson-objective-review"],
      toolGroups: ["document-read", "document-write"],
      mcpServers: [],
      specialistAgents: ["curriculum-analysis"],
    });
  });

  it("returns the deterministic write plan without waiting for the Flash router", async () => {
    await expect(routeCapabilities("请重新更改教学重点难点")).resolves.toEqual(
      deterministicCapabilityPlan("请重新更改教学重点难点"),
    );
  });
});
