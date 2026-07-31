import { describe, expect, it } from "vitest";

import {
  deterministicCapabilityPlan,
  enforceRequiredCapabilities,
  hasDeterministicRoutingSignal,
  isConversationalControlMessage,
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
      evidenceRequired: false,
    });

    expect(plan.toolGroups).toEqual(["document-read", "document-write"]);
  });

  it("keeps the approval-gated write tool available for read-only questions", () => {
    const plan = enforceRequiredCapabilities("概括当前教学目标", {
      skillIds: [],
      toolGroups: ["document-read"],
      mcpServers: [],
      specialistAgents: [],
      evidenceRequired: false,
    });

    expect(plan.toolGroups).toEqual(["document-read", "document-write"]);
  });

  it("does not require external evidence merely because the teacher asks for current content", () => {
    expect(deterministicCapabilityPlan("查看当前教学内容")).toMatchObject({
      mcpServers: [],
      evidenceRequired: false,
    });
    expect(deterministicCapabilityPlan("核对当前教案文件和文档版本")).toMatchObject({
      mcpServers: [],
      evidenceRequired: false,
    });
    expect(deterministicCapabilityPlan("修改这一处，其他原文保持不变")).toMatchObject({
      mcpServers: [],
      evidenceRequired: false,
    });
  });

  it("keeps broad optimization intent consultative without hiding the standard write tool", () => {
    expect(requiresDocumentWrite("你认为现在还有哪些需要调整和优化？")).toBe(false);
    const plan = enforceRequiredCapabilities("你认为现在还有哪些需要调整和优化？", {
      skillIds: ["lesson-critique"],
      toolGroups: ["document-read", "document-write"],
      mcpServers: [],
      specialistAgents: ["critic"],
      evidenceRequired: false,
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

  it("retrieves evidence before writing verifiable biographical facts", () => {
    expect(deterministicCapabilityPlan("请补充晏殊生平并提交修改")).toMatchObject({
      mcpServers: ["knowledge"],
      toolGroups: ["document-read", "document-write"],
      evidenceRequired: true,
    });
  });

  it("treats common Chinese factual additions as evidence-required", () => {
    expect(deterministicCapabilityPlan("请补充王安石的籍贯和所处朝代")).toMatchObject({
      mcpServers: ["knowledge"],
      evidenceRequired: true,
    });
    expect(deterministicCapabilityPlan("请把这句古文的译文写入教案")).toMatchObject({
      mcpServers: ["knowledge"],
      evidenceRequired: true,
    });
  });

  it("requires evidence when the teacher explicitly refers to an uploaded file", () => {
    expect(deterministicCapabilityPlan("请根据我上传的文件核对这段内容")).toMatchObject({
      mcpServers: ["knowledge"],
      evidenceRequired: true,
    });
  });

  it("inspects the lesson body when a broad review can encounter factual claims", () => {
    expect(deterministicCapabilityPlan("请全面审查这份教案", {
      document: {
        unit: "第一单元",
        period: "1",
        totalPeriods: "1",
        topic: "浣溪沙",
        objectives: "理解作者晏殊的北宋生平背景",
        focus: "",
        preparation: "",
        process: "",
        assessment: "",
        homework: "",
        board: "",
        reflection: "",
      },
    })).toMatchObject({
      mcpServers: ["knowledge"],
      evidenceRequired: true,
    });
  });

  it("requires an actual attachment read for a named message attachment", () => {
    expect(deterministicCapabilityPlan("请根据附件判断目标是否合理", {
      attachmentSourceIds: ["source-1"],
    })).toMatchObject({
      evidenceRequired: true,
      requiredEvidenceKinds: ["attachment_read"],
    });
  });

  it("returns the deterministic write plan without waiting for the Flash router", async () => {
    await expect(routeCapabilities("请重新更改教学重点难点")).resolves.toEqual(
      deterministicCapabilityPlan("请重新更改教学重点难点"),
    );
  });

  it("keeps conversational control turns off the model-router critical path", async () => {
    expect(isConversationalControlMessage("暂时不需要")).toBe(true);
    expect(isConversationalControlMessage("收到，谢谢")).toBe(true);
    await expect(routeCapabilities("暂时不需要")).resolves.toEqual(
      deterministicCapabilityPlan("暂时不需要"),
    );
  });

  it("keeps deterministically classified teaching work off the model-router critical path", async () => {
    const plan = deterministicCapabilityPlan("请检查教学目标与重点");
    expect(hasDeterministicRoutingSignal(plan)).toBe(true);
    await expect(routeCapabilities("请检查教学目标与重点")).resolves.toEqual(plan);
  });

  it("does not block a generic turn on probabilistic metadata routing", async () => {
    await expect(routeCapabilities("帮我看看接下来可以从哪方面继续完善")).resolves.toEqual(
      deterministicCapabilityPlan("帮我看看接下来可以从哪方面继续完善"),
    );
  });
});
