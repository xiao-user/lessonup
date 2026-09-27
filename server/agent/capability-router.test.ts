import { describe, expect, it } from "vitest";

import { createNodeSkillRegistry } from "./skill-registry-node.js";
import {
  deterministicCapabilityPlan,
  documentWriteMode,
  enforceRequiredCapabilities,
  hasDeterministicRoutingSignal,
  isConversationalControlMessage,
  isFastChatTurn,
  isFastFollowUpMessage,
  requiresDocumentWrite,
  requestedDocumentFieldsFor,
  routeCapabilities,
} from "./capability-router.js";

describe("enforceRequiredCapabilities", () => {
  it("keeps acknowledgements tool-free instead of inheriting the preceding task", () => {
    for (const message of ["好", "好的", "没问题", "收到", "OK", "Thanks", "Thank you", "Got it"]) {
      expect(deterministicCapabilityPlan(message), message).toMatchObject({
        lightweightConversation: true,
        executionLane: "fast",
        presentationRequested: false,
        skillIds: [],
        toolGroups: [],
      });
    }
  });

  it("routes explicit classroom presentation intent to the approval-gated Dashi goal tool", () => {
    expect(deterministicCapabilityPlan("基于当前教案生成一份上课用的交互 PPT")).toMatchObject({
      presentationRequested: true,
      skillIds: ["dashi-ppt"],
      toolGroups: ["presentation-create"],
      mcpServers: [],
      specialistAgents: [],
      writeMode: "consultative",
      evidenceRequired: false,
    });
    expect(deterministicCapabilityPlan("请修改 A4 教案中的教学过程")).toMatchObject({
      presentationRequested: false,
    });
    for (const message of [
      "请基于当前教案设计课堂演示，先给我确认",
      "直接渲染",
      "把确认后的脚本交给 Dashi 渲染",
      "直接调用 dashi skill 就行了",
    ]) {
      expect(deterministicCapabilityPlan(message), message).toMatchObject({
        presentationRequested: true,
        skillIds: ["dashi-ppt"],
        toolGroups: ["presentation-create"],
        evidenceRequired: false,
      });
    }
  });

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
    expect(requiresDocumentWrite("重新整理当前教案")).toBe(true);
    expect(requiresDocumentWrite("好的，请按上面的方案调整教案")).toBe(true);
    expect(requiresDocumentWrite("就按刚才的建议完善一下")).toBe(true);
    expect(requiresDocumentWrite("把这些建议落实到教学过程")).toBe(true);
    expect(requiresDocumentWrite("给我列出三条优化建议")).toBe(false);
    expect(requiresDocumentWrite("为什么要修改教学过程？")).toBe(false);
  });

  it("separates broad read context from the teacher's narrow write targets", () => {
    expect(requestedDocumentFieldsFor(
      "请依据重点知识和教学过程，把教学目标写成一条可观察、可评价的目标，并提交修改建议",
    )).toEqual(["objectives"]);
    expect(requestedDocumentFieldsFor(
      "请修改教学目标和评价练习，并等待我确认",
    )).toEqual(["objectives", "assessment"]);
    expect(deterministicCapabilityPlan(
      "请把教学目标写成一条可观察、可评价的目标，并提交修改建议，等待我确认后再写入。",
    )).toMatchObject({
      writeMode: "explicit",
      requestedDocumentFields: ["objectives"],
    });
  });

  it("uses an explicit selection only for a deictic write request", () => {
    expect(deterministicCapabilityPlan("请修改这一处，其他原文保持不变", {
      activeSectionId: "process",
      selectionField: "objectives",
    })).toMatchObject({ requestedDocumentFields: ["objectives"] });
    expect(deterministicCapabilityPlan("请重新编写教案", {
      activeSectionId: "objectives",
    }).requestedDocumentFields).toBeUndefined();
  });

  it("separates consultation from explicit approval intent", () => {
    expect(documentWriteMode("你认为当前教案还有哪些需要调整的地方？")).toBe("consultative");
    expect(documentWriteMode("请联网查找依据，再判断是否需要调整")).toBe("consultative");
    expect(documentWriteMode("提交最小修改建议，等待我确认后再写入")).toBe("explicit");
    expect(documentWriteMode("请把模板教案转化为具体设计，生成一次确认项")).toBe("explicit");
    expect(documentWriteMode("未经我批准不要写入，最后只生成一次完整备课调整确认项")).toBe("explicit");
    expect(documentWriteMode("好的，请按上面的方案调整教案")).toBe("explicit");
    expect(documentWriteMode("继续")).toBe("open");
  });

  it("only enables structured design-basis writes when the teacher explicitly requests them", () => {
    expect(deterministicCapabilityPlan("重新编写教案")).toMatchObject({
      writeMode: "explicit",
      designBasisRequested: false,
      designBasisWriteRequested: false,
      fullRewriteRequested: true,
      minimalWriteRequested: false,
      mcpServers: ["knowledge"],
      evidenceRequired: true,
      requiredEvidenceKinds: ["curriculum_standard_search"],
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

  it("treats reorganizing the current lesson as a complete evidence-bound rewrite", () => {
    expect(deterministicCapabilityPlan("重新整理当前教案")).toMatchObject({
      writeMode: "explicit",
      fullRewriteRequested: true,
      skillIds: ["lesson-full-authoring"],
      requestedDocumentFields: undefined,
      mcpServers: ["knowledge"],
      evidenceRequired: true,
      requiredEvidenceKinds: ["curriculum_standard_search"],
    });
    for (const message of ["重新编写教案", "请把当前模板教案重编为具体教案"]) {
      expect(deterministicCapabilityPlan(message), message).toMatchObject({
        writeMode: "explicit",
        fullRewriteRequested: true,
        skillIds: ["lesson-full-authoring"],
      });
    }
  });

  it("answers a rewrite deliberation instead of routing it to the authoring path", () => {
    for (const message of [
      "先判断这份教案是否需要重新编写",
      "不要写入，只分析整份教案要不要重编",
      "请先只做分析：整份教案重写是否值得",
      "你认为需要重新整理当前教案吗？",
      "要不要重新编写整份教案？",
    ]) {
      expect(deterministicCapabilityPlan(message), message).toMatchObject({
        writeMode: "consultative",
        fullRewriteRequested: true,
        // The authoring skill requires propose_document_patch, which a
        // consultative turn never creates. Selecting it here used to fail the
        // run before the model was called.
        skillIds: [],
        evidenceRequired: false,
      });
    }
  });

  it("reads one deliberation vocabulary across write detection and write mode", () => {
    // “整理/重编/编写/改写” are write verbs for detection, so they must also be
    // recognized as deliberation when a teacher only asks whether to apply them.
    for (const message of [
      "你认为需要重新整理当前教案吗？",
      "要不要重新编写整份教案？",
      "这份教案该不该整理一遍？",
      "你觉得教学过程值得改写吗？",
    ]) {
      expect(requiresDocumentWrite(message), message).toBe(false);
      expect(documentWriteMode(message), message).toBe("consultative");
    }
    for (const message of [
      "请优化教学目标并提交修改",
      "按照这些内容重新更改教学重点难点",
      "重新编写教案",
      "重新整理当前教案",
    ]) {
      expect(requiresDocumentWrite(message), message).toBe(true);
      expect(documentWriteMode(message), message).toBe("explicit");
    }
  });

  it("never pairs a skill's required write tool with a turn that forbids it", async () => {
    const registry = await createNodeSkillRegistry().load();
    for (const message of [
      "先判断这份教案是否需要重新编写",
      "你认为需要重新整理当前教案吗？",
      "要不要重新编写整份教案？",
      "重新整理当前教案",
      "请优化教学目标并提交修改",
      "你认为现在还有哪些需要调整和优化？",
      "请检查教学目标与重点",
      "本课与课程标准中的哪些内容要求相关？不要修改教案。",
    ]) {
      const plan = deterministicCapabilityPlan(message);
      const requiredTools = registry.resolve(plan.skillIds).flatMap((skill) => skill.requiredTools);
      // Mirrors the single authority decision in PiLessonAgentCoordinator:
      // the document proposal tool exists only outside a consultative turn.
      if (plan.writeMode === "consultative") {
        expect(requiredTools, message).not.toContain("propose_document_patch");
      }
    }
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
      executionLane: "fast",
      writeMode: "consultative",
      toolGroups: [],
      specialistAgents: [],
      mcpServers: [],
    });
    expect(deterministicCapabilityPlan("可以")).toMatchObject({
      lightweightConversation: false,
      executionLane: "agent",
    });
  });

  it("sends short clarifying follow-ups through Fast chat, not the Agent prefix", () => {
    expect(deterministicCapabilityPlan("刚才那句是什么意思？")).toMatchObject({
      executionLane: "fast",
      lightweightConversation: false,
      writeMode: "consultative",
      toolGroups: [],
      skillIds: [],
    });
    expect(isFastFollowUpMessage("为什么？")).toBe(true);
    expect(isFastChatTurn("好的 谢谢")).toBe(true);
    expect(isFastFollowUpMessage("教学过程写得怎么样？")).toBe(false);
    expect(deterministicCapabilityPlan("教学过程写得怎么样？").executionLane).toBe("agent");
    expect(deterministicCapabilityPlan("请修改教学过程").executionLane).toBe("agent");
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
    expect(deterministicCapabilityPlan(
      "根据课堂反馈调整下一课时的衔接效果",
    )).toMatchObject({
      continuityRequested: true,
    });
    expect(deterministicCapabilityPlan(
      [
        "【衔接回写】",
        "feedbackId:11111111-1111-4111-8111-111111111111",
        "请基于刚保存的课堂反馈，提出一次学期框架修改审批。",
      ].join("\n"),
    )).toMatchObject({
      writeMode: "explicit",
      continuityRequested: true,
      classroomActionRequired: true,
      continuityWritebackFeedbackId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not mistake A4 business content for an external research request", () => {
    expect(deterministicCapabilityPlan(
      "把平台知识点、教学依据和评价证据写入整份教案",
    )).toMatchObject({
      mcpServers: [],
      evidenceRequired: false,
    });
    expect(deterministicCapabilityPlan(
      "请结合重点知识、教学过程和评价练习，把教学目标改成一条可观察、可评价的目标，并提交修改建议",
      {
        document: {
          unit: "第一单元",
          period: "第1课时",
          totalPeriods: "2",
          topic: "春",
          objectives: "理解朱自清笔下的春天",
          knowledgePoints: "景物描写",
          continuity: "",
          focus: "",
          preparation: "",
          process: "圈画文本",
          assessment: "概括春景",
          homework: "",
          board: "",
          reflection: "",
        },
      },
    )).toMatchObject({
      mcpServers: [],
      evidenceRequired: false,
      requestedDocumentFields: ["objectives"],
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
      mcpServers: ["knowledge"],
      evidenceRequired: true,
      requiredEvidenceKinds: ["curriculum_standard_search"],
      specialistAgents: [],
    });
  });

  it("requires a scoped curriculum-standard read for explicit standard work", () => {
    expect(deterministicCapabilityPlan(
      "请依据课程标准调整教学目标并提交修改",
    )).toMatchObject({
      mcpServers: ["knowledge"],
      evidenceRequired: true,
      requiredEvidenceKinds: ["curriculum_standard_search"],
    });
    expect(deterministicCapabilityPlan(
      "本课与课程标准中的哪些内容要求相关？不要修改教案。",
    )).toMatchObject({
      writeMode: "consultative",
      mcpServers: ["knowledge"],
      evidenceRequired: true,
      requiredEvidenceKinds: ["curriculum_standard_search"],
    });
    expect(deterministicCapabilityPlan(
      "请继续依据刚才检索到的课程标准展开分析，只分析，不修改教案。",
    )).toMatchObject({
      evidenceRequired: true,
      requiredEvidenceKinds: ["curriculum_standard_search"],
      reuseRecentEvidence: true,
    });
  });

  it("routes an explicit document change without requiring a model decision", () => {
    expect(deterministicCapabilityPlan("按照这些内容重新更改教学重点难点")).toMatchObject({
      skillIds: ["lesson-objective-review"],
      toolGroups: ["document-read", "document-write"],
      mcpServers: [],
      specialistAgents: [],
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
