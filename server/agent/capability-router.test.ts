import { describe, expect, it } from "vitest";

import {
  deterministicCapabilityPlan,
  documentWriteMode,
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

  it("does not confuse the design-basis resource name with an external evidence request", () => {
    expect(deterministicCapabilityPlan("把这个学生困难保存为教案设计依据")).toMatchObject({
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
    expect(requiresDocumentWrite("只对最关键一处问题提交最小修改建议，等待我确认后再写入")).toBe(true);
    expect(requiresDocumentWrite("先判断当前教案是否需要调整，不要写入")).toBe(false);
    expect(requiresDocumentWrite("重新编写教案")).toBe(true);
  });

  it("separates consultation from explicit approval intent", () => {
    expect(documentWriteMode("你认为当前教案还有哪些需要调整的地方？")).toBe("consultative");
    expect(documentWriteMode("请联网查找依据，再判断是否需要调整")).toBe("consultative");
    expect(documentWriteMode("提交最小修改建议，等待我确认后再写入")).toBe("explicit");
    expect(documentWriteMode("请把模板教案转化为具体设计，生成一次确认项")).toBe("explicit");
    expect(documentWriteMode("未经我批准不要写入，最后只生成一次完整备课调整确认项")).toBe("explicit");
    expect(documentWriteMode("继续")).toBe("open");
  });

  it("only enables structured design-basis writes when the teacher explicitly requests them", () => {
    expect(deterministicCapabilityPlan("重新编写教案")).toMatchObject({
      writeMode: "explicit",
      designBasisRequested: false,
      designBasisWriteRequested: false,
      fullRewriteRequested: true,
      minimalWriteRequested: false,
    });
    expect(deterministicCapabilityPlan("把这个学生困难保存为教案设计依据")).toMatchObject({
      writeMode: "explicit",
      designBasisRequested: true,
      designBasisWriteRequested: true,
    });
    expect(deterministicCapabilityPlan("把已有设计依据落实到教案评价中")).toMatchObject({
      designBasisRequested: true,
      designBasisWriteRequested: true,
    });
    expect(deterministicCapabilityPlan(
      "请完整编写教案并提交修改。先读取上游备课上下文和教案设计依据。",
    )).toMatchObject({
      fullRewriteRequested: true,
      designBasisRequested: true,
      designBasisWriteRequested: false,
    });
    expect(deterministicCapabilityPlan("请新增一条设计依据并保存")).toMatchObject({
      designBasisWriteRequested: true,
    });
  });

  it("uses a bound blueprint as upstream context without relying on prompt keywords", () => {
    expect(deterministicCapabilityPlan("请重新编写教案", {
      hasUpstreamPlanningContext: true,
    })).toMatchObject({
      fullRewriteRequested: true,
      designBasisRequested: true,
      designBasisWriteRequested: false,
    });
  });

  it("routes dismissal and thanks to the lightweight no-tool conversation path", () => {
    expect(deterministicCapabilityPlan("暂时不需要")).toMatchObject({
      lightweightConversation: true,
      writeMode: "consultative",
      toolGroups: [],
      specialistAgents: [],
      mcpServers: [],
    });
    expect(deterministicCapabilityPlan("可以")).toMatchObject({
      lightweightConversation: false,
    });
  });

  it("does not send the curriculum catalog tool surface on unrelated turns", () => {
    expect(deterministicCapabilityPlan("请帮我调整课堂提问语气")).toMatchObject({
      curriculumRequested: false,
    });
    expect(deterministicCapabilityPlan("核对当前章节知识点并设计复习活动")).toMatchObject({
      curriculumRequested: true,
    });
  });

  it("turns precise teacher intent into deterministic execution boundaries", () => {
    expect(deterministicCapabilityPlan(
      "只对最关键一处问题提交最小修改建议，等待我确认后再写入",
    )).toMatchObject({
      minimalWriteRequested: true,
      fullRewriteRequested: false,
      skillIds: [],
      specialistAgents: [],
      mcpServers: [],
      evidenceRequired: false,
    });
    expect(deterministicCapabilityPlan(
      "请联网核对后给出一项可执行的课堂调整",
    )).toMatchObject({
      classroomActionRequired: true,
    });
    expect(deterministicCapabilityPlan(
      "说明它会怎样影响具体课时活动和学生产出",
    )).toMatchObject({
      classroomActionRequired: true,
    });
    expect(deterministicCapabilityPlan(
      "查看当前单元最值得保留的复习或铺垫安排",
    )).toMatchObject({
      continuityRequested: true,
    });
    expect(deterministicCapabilityPlan(
      "请生成整学期六个单元的课时蓝图",
    )).toMatchObject({
      continuityRequested: true,
    });
  });

  it("does not mistake A4 business content for an external research request", () => {
    expect(deterministicCapabilityPlan(
      "把平台知识点、教学依据和评价证据写入整份教案",
    )).toMatchObject({
      mcpServers: [],
      evidenceRequired: false,
    });
  });

  it("honors an explicit request not to maintain structured design basis during a rewrite", () => {
    expect(deterministicCapabilityPlan(
      "当前按40分钟一课时、暂按中等学情处理。请把当前模板教案直接重编为针对当前课题的具体教案：需要平台知识点时先读取并核验，把知识点、学生困难、教学依据和评价证据写入A4。最后只生成一次教案修改确认项；不要建立或修改结构化设计依据。",
    )).toMatchObject({
      writeMode: "explicit",
      fullRewriteRequested: true,
      designBasisRequested: false,
      designBasisWriteRequested: false,
      mcpServers: [],
      evidenceRequired: false,
      specialistAgents: [],
    });
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

  it("requires opened webpage content for an explicit web request", () => {
    expect(deterministicCapabilityPlan("请联网搜索并给出一项课堂调整")).toMatchObject({
      mcpServers: ["web"],
      evidenceRequired: true,
      requiredEvidenceKinds: ["web_open"],
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
        knowledgePoints: "作者与作品背景",
        continuity: "",
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
