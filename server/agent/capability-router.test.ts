import { describe, expect, it } from "vitest";

import { createNodeSkillRegistry } from "./skill-registry-node.js";
import {
  deterministicCapabilityPlan,
  documentWriteMode,
  isConversationalControlMessage,
  isFastChatTurn,
  isFastFollowUpMessage,
  requiresDocumentWrite,
  requestedDocumentFieldsFor,
  routeCapabilities,
} from "./capability-router.js";

describe("deterministic turn policy", () => {
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


  it("recognizes an explicit optimization command as write intent", () => {
    expect(requiresDocumentWrite("请优化教学目标并提交修改")).toBe(true);
    expect(requiresDocumentWrite("按照这些内容重新更改教学重点难点")).toBe(true);
    expect(requiresDocumentWrite("只对最关键一处问题提交最小修改建议，等待我确认后再写入")).toBe(true);
    expect(requiresDocumentWrite("先判断当前教案是否需要调整，不要写入")).toBe(false);
    expect(requiresDocumentWrite("先分析当前课堂最应该验证的问题，不修改教案。")).toBe(false);
    expect(requiresDocumentWrite("这处问题不得不修改，请提交修改确认。")).toBe(true);
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
      mcpServers: [],
      evidenceRequired: false,
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

  it("keeps complete rewrite scope independent from an external source claim", () => {
    expect(deterministicCapabilityPlan("重新整理当前教案")).toMatchObject({
      writeMode: "explicit",
      fullRewriteRequested: true,
      skillIds: [],
      requestedDocumentFields: undefined,
      mcpServers: [],
      evidenceRequired: false,
    });
    for (const message of ["重新编写教案", "请把当前模板教案重编为具体教案"]) {
      expect(deterministicCapabilityPlan(message), message).toMatchObject({
        writeMode: "explicit",
        fullRewriteRequested: true,
        skillIds: [],
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
      mcpServers: [],
      evidenceRequired: false,
    });
  });

  it("does not turn absent classroom data into a retrieval requirement in the actual teacher request", () => {
    const message = "请依据教师给定要求，从当前空白文档完整编写全栏教案并提交A4待确认草稿。这是隔离的七年级数学40分钟设计演练，没有真实学生数据，不绑定教材页码或课标引文。主题：等式的基本性质，第1课时，总1课时。先备知识只作为待核对前提：会四则运算，知道等号表示两边相等。目标：能通过等式两边同时作相同运算解释为什么仍相等，识别只改一边的错误，除数不能为0。以x+3=7、2x=10等简单例子，不引入移项口诀或复杂方程。40分钟包括独立初答、天平或等值表示解释、比较正确与错误步骤、撤去支架独立练习、出口条；每段时间合计40分钟。出口条至少一题要求说明理由，评分区分答案正确与理由成立，给出教师据不同回答如何反馈。作业适量，反思写待收集问题，不编造成效。无需PPT。请保留数学条件，明确可核对的任务、学生产出及成功判据；未知情况写待核对。";
    expect(deterministicCapabilityPlan(message)).toMatchObject({ fullRewriteRequested: true, evidenceRequired: false });
    expect(deterministicCapabilityPlan(message).requiredEvidenceKinds).toBeUndefined();
    expect(deterministicCapabilityPlan("没有真实学生数据，请依据课程标准完整编写教案。")).toMatchObject({
      evidenceRequired: true, requiredEvidenceKinds: ["curriculum_standard_search"],
    });
  });

  it.each([
    "完整编写教案，不能不引用课标。",
    "完整编写教案，不得不依据课程标准。",
    "完整编写教案，不要不核验课标。",
  ])("retains affirmative source requirements expressed as double negatives (%s)", (message) => {
    expect(deterministicCapabilityPlan(message)).toMatchObject({ evidenceRequired: true, requiredEvidenceKinds: ["curriculum_standard_search"] });
  });

  it.each([
    "请完整编写等式基本性质教案：40分钟，以独立判断等式变形及说明理由为目标，出口条分别记录判断与解释，提交审批。",
    "请依据教师给定要求完整编写教案并提交确认，无需引用课标。",
    "请依据当前信息完整编写教案，不绑定教材页码或课标引文。",
    "完整编写教案：按我的目标与任务设计，不引用未核实课标。",
  ])("allows a teacher-defined design draft without inventing a required source (%s)", (message) => {
    const plan = deterministicCapabilityPlan(message);
    expect(plan).toMatchObject({ fullRewriteRequested: true, writeMode: "explicit", evidenceRequired: false, mcpServers: [] });
    expect(plan.requiredEvidenceKinds).toBeUndefined();
  });

  it.each([
    ["完整编写教案，无需引用课标，但须读取附件并核对其中的任务。", ["attachment_read"], ["knowledge"]],
    ["完整编写教案，不绑定教材页码或课标引文；请联网核验最新统计数据。", ["web_open"], ["knowledge", "web"]],
    ["完整编写教案，不引用教材原句，但必须对齐课程标准。", ["curriculum_standard_search"], ["knowledge"]],
    ["仅提交最小修改，不引用课标，并核验作者生平。", undefined, ["knowledge"]],
    ["完整编写教案，请依据课程标准，同时读取附件。", ["curriculum_standard_search", "attachment_read"], ["knowledge"]],
  ])("retains adjacent affirmative evidence requirements (%s)", (message, kinds, servers) => {
    const plan = deterministicCapabilityPlan(message as string, { attachmentSourceIds: ["source-1"] });
    expect(plan.evidenceRequired).toBe(true);
    expect(plan.mcpServers).toEqual(servers);
    expect(plan.requiredEvidenceKinds).toEqual(kinds);
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
      skillIds: [],
      toolGroups: ["document-read", "document-write"],
      mcpServers: [],
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
    await expect(routeCapabilities("请检查教学目标与重点")).resolves.toEqual(plan);
  });

  it("does not block a generic turn on probabilistic metadata routing", async () => {
    await expect(routeCapabilities("帮我看看接下来可以从哪方面继续完善")).resolves.toEqual(
      deterministicCapabilityPlan("帮我看看接下来可以从哪方面继续完善"),
    );
  });
});

describe("Fast chat eligibility", () => {
  it("keeps questions about the lesson on the Agent lane, where the document can be read", () => {
    for (const message of [
      "这节课的导入是不是太长了？",
      "这个环节的时间安排合理吗？",
      "我的目标写得清楚吗？",
      "整篇教案有没有前后矛盾的地方？",
      "小组讨论这一块怎么样？",
      "学生会不会听不懂第二个活动？",
      // “上面”“第二条”在教案里多半指文档位置，不是上一条回复。
      "第二条目标为什么这样写？",
      "上面的导入是不是太长了？",
    ]) {
      expect(isFastFollowUpMessage(message), message).toBe(false);
      expect(deterministicCapabilityPlan(message).executionLane, message).toBe("agent");
    }
  });

  it("does not let a question about facts bypass the evidence policy", () => {
    for (const message of [
      "《春》的作者朱自清是哪一年出生的？",
      "《背影》的写作背景是什么？",
      "刚才说的他是哪一年出生的？",
    ]) {
      expect(deterministicCapabilityPlan(message), message).toMatchObject({
        executionLane: "agent",
        evidenceRequired: true,
        mcpServers: ["knowledge"],
      });
    }
  });

  it("still answers follow-ups that point back at the conversation without tools", () => {
    for (const message of [
      "为什么？",
      "什么意思？",
      "刚才那句是什么意思？",
      "为什么这样改？",
      "再解释一下第二点",
      "你刚才说的第二点具体怎么做？",
      "举个例子",
      "然后呢？",
    ]) {
      expect(isFastFollowUpMessage(message), message).toBe(true);
      expect(deterministicCapabilityPlan(message), message).toMatchObject({
        executionLane: "fast",
        toolGroups: [],
        evidenceRequired: false,
      });
    }
  });
});

describe("courseware presentation intent", () => {
  it("recognizes how teachers actually ask for a courseware", () => {
    for (const message of [
      "做一个课件",
      "帮我制作课件",
      "生成课件",
      "我要上课用的PPT",
      "帮我出一份PPT",
      "来个课件吧",
      "把教案改成课件",
      "课件做一下",
      "帮我做个幻灯片",
    ]) {
      expect(deterministicCapabilityPlan(message), message).toMatchObject({
        presentationRequested: true,
        skillIds: ["dashi-ppt"],
        toolGroups: ["presentation-create"],
      });
    }
  });

  it("does not read a reference to an existing courseware as a request to make one", () => {
    for (const message of [
      "把课件里的例题补充到教案",
      "根据课件调整教学过程",
      "课件里有一处错别字，帮我改一下",
      "指出课件中的问题",
    ]) {
      expect(deterministicCapabilityPlan(message).presentationRequested, message).toBe(false);
    }
  });
});
