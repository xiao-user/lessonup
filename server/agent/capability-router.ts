import { z } from "zod";
import { parseContinuityWritebackFeedbackId } from "../curriculum/continuity-adoption.js";
import type { CapabilityPlan, LessonPlan } from "../domain.js";

export const capabilityPlanSchema = z.object({
  skillIds: z.array(z.enum([
    "lesson-objective-review",
    "lesson-process-design",
    "lesson-assessment-alignment",
    "lesson-critique",
  ])).max(3),
  toolGroups: z.array(z.enum(["document-read", "document-write"])).max(2),
  mcpServers: z.array(z.enum(["knowledge", "web"])).max(2),
  specialistAgents: z.array(z.enum([
    "curriculum-analysis",
    "learning-design",
    "assessment",
    "critic",
  ])).max(3),
  evidenceRequired: z.boolean().default(false),
  writeMode: z.enum(["consultative", "open", "explicit"]).default("open"),
  designBasisRequested: z.boolean().default(false),
  designBasisWriteRequested: z.boolean().default(false),
  minimalWriteRequested: z.boolean().default(false),
  fullRewriteRequested: z.boolean().default(false),
  classroomActionRequired: z.boolean().default(false),
  continuityRequested: z.boolean().default(false),
  continuityWritebackFeedbackId: z.string().uuid().optional(),
  lightweightConversation: z.boolean().default(false),
  curriculumRequested: z.boolean().default(false),
  requiredEvidenceKinds: z.array(z.enum([
    "knowledge_search",
    "knowledge_passage",
    "attachment_read",
    "source_metadata",
    "web_search",
    "web_open",
  ])).max(3).optional(),
});

const externalEvidencePattern = /教材|课标|文献|依据|来源|出处|课文原文|作品原文|古文原文|原句|引文|引用|作者|人物|生平|籍贯|朝代|年代|历史|背景|事实|数据|政策|法规|统计|定义|释义|译文|翻译|考据|真伪|是否出自|谁写|哪一年|哪一朝|最新|近期/;
const attachmentReferencePattern = /附件|上传的?(?:文件|资料)|我(?:上传|提供)的?(?:文件|资料)|根据(?:这份|该|上述)?(?:文件|资料)/;
const broadReviewPattern = /全面|整体|完整|全局|整份|通篇|审查|检查|评估|评价/;
const explicitConsultationPattern = /(?:先|暂时|目前).{0,8}(?:给|只做|只).{0,8}(?:建议|分析|判断|检查|审查|评估)|(?:不要|不用|不必|无需).{0,8}(?:写入|修改|生成确认)|先判断|只(?:做)?(?:检查|审查|评估|分析)/;
const explicitApprovalPattern = /(?:提交|生成|创建).{0,14}(?:修改|调整|建议|确认项|审批)|(?:等待|由|让我).{0,8}(?:确认|批准).{0,8}(?:再|后).{0,4}(?:写入|修改)/;
// Reading upstream planning context and writing the teacher-facing A4 lesson are
// ordinary lesson operations. Only route to the structured design-basis write
// surface when the teacher explicitly asks to persist or maintain that resource.
// A loose proximity match here used to misread phrases such as “完整教案修改 …
// 设计依据” as a second structured write request, expanding a simple rewrite
// into a much larger and failure-prone tool loop.
const designBasisWritePattern = /(?:保存|记录)(?:为|到|进|至)?(?:本课|当前|结构化|教案)*设计依据|形成(?:一条|必要|本课|当前|结构化)*设计依据|(?:新增|添加|建立|删除|纠正|修改)(?:一条|这条|这些|当前|已有|结构化|教案|\s){0,8}设计依据|设计依据(?:记录)?(?:中|里)?(?:新增|添加|删除|纠正|修改)|(?:把|将)?(?:已确认|已有|当前)?的?设计依据落实到(?:教案|A4|目标|评价|过程)/;
const minimalWritePattern = /(?:只|仅).{0,12}(?:一处|一个栏目|最关键).{0,16}(?:修改|调整|建议)|(?:最小|最少).{0,8}(?:修改|调整|建议)|只生成一处/;
const fullRewritePattern = /重新(?:编写|改写|重写|重编)|(?:整份|完整|全面).{0,10}(?:重写|重编|改写|编写)|重编(?:当前)?教案|把.{0,12}模板教案.{0,12}(?:转化|重编|改写)/;
const classroomActionPattern = /可执行|直接实施|课堂调整|具体课时活动|学生产出|达成证据|落实到.{0,8}(?:课堂|活动)|教师动作|学生任务|可观察(?:产出|证据|表现)/;
const designBasisDeniedPattern = /(?:不要|不用|无需|不必|禁止).{0,16}(?:结构化)?设计依据|(?:结构化)?设计依据.{0,16}(?:不要|不用|无需|不必|禁止|不建立|不修改)/;
const semesterPlanningContinuityPattern = /整学期|整体教学框架|学期规划|单元规划|课时蓝图|规划.{0,12}(?:单元|课时)|生成.{0,12}蓝图|完善.{0,12}框架/;

function documentContainsVerifiableClaims(document?: LessonPlan) {
  return document
    ? externalEvidencePattern.test(Object.values(document).join("\n"))
    : false;
}

export const deterministicCapabilityPlan = (
  message: string,
  options: {
    document?: LessonPlan;
    attachmentSourceIds?: string[];
    hasUpstreamPlanningContext?: boolean;
  } = {},
): CapabilityPlan => {
  const fullRewriteRequested = fullRewritePattern.test(message);
  const designBasisDenied = designBasisDeniedPattern.test(message);
  const writebackFeedbackId = parseContinuityWritebackFeedbackId(message);
  const lightweightConversation = !writebackFeedbackId && isConversationalControlMessage(message);
  const plan: CapabilityPlan = {
    skillIds: [],
    toolGroups: ["document-read", "document-write"],
    mcpServers: [],
    specialistAgents: [],
    evidenceRequired: false,
    writeMode: writebackFeedbackId
      ? "explicit"
      : lightweightConversation ? "consultative" : documentWriteMode(message),
    designBasisRequested: !designBasisDenied && (
      /设计依据|上游备课上下文/.test(message)
      || (fullRewriteRequested && options.hasUpstreamPlanningContext === true)
    ),
    designBasisWriteRequested: !designBasisDenied && designBasisWritePattern.test(message),
    minimalWriteRequested: !fullRewriteRequested && minimalWritePattern.test(message),
    fullRewriteRequested,
    classroomActionRequired: Boolean(writebackFeedbackId) || classroomActionPattern.test(message),
    continuityRequested: Boolean(writebackFeedbackId)
      || /复习|铺垫|连续性|前后衔接|课堂反馈|衔接效果|练习缺口|错因/.test(message)
      || semesterPlanningContinuityPattern.test(message),
    continuityWritebackFeedbackId: writebackFeedbackId ?? undefined,
    lightweightConversation,
    curriculumRequested: Boolean(writebackFeedbackId)
      || /教材|章节|目录|知识点|学习要点|课时蓝图|复习|铺垫|连续性|前后衔接|课堂反馈|衔接效果/.test(message),
  };
  if (lightweightConversation) {
    return capabilityPlanSchema.parse({
      ...plan,
      toolGroups: [],
      mcpServers: [],
      specialistAgents: [],
      skillIds: [],
      evidenceRequired: false,
    });
  }
  // 下列词在 LessonUp 中描述的是教案业务产物，不等于教师要求检索
  // 外部出处。剔除固定业务词后仍命中证据词，才启动知识 MCP。
  const externalEvidenceRequest = externalEvidencePattern.test(
    message
      .replaceAll("教案设计依据", "")
      .replaceAll("设计依据", "")
      .replaceAll("平台知识点", "")
      .replaceAll("教材知识点", "")
      .replaceAll("教学依据", "")
      .replaceAll("评价证据", ""),
  );
  if (/目标|课标|重点|难点/.test(message)) {
    plan.skillIds.push("lesson-objective-review");
    plan.specialistAgents.push("curriculum-analysis");
  }
  if (/过程|活动|问题链|板书|作业/.test(message)) {
    plan.skillIds.push("lesson-process-design");
    plan.specialistAgents.push("learning-design");
  }
  if (/评价|练习|达成|一致性/.test(message)) {
    plan.skillIds.push("lesson-assessment-alignment");
    plan.specialistAgents.push("assessment");
  }
  if (externalEvidenceRequest) {
    plan.mcpServers.push("knowledge");
    plan.evidenceRequired = true;
  }
  if (
    broadReviewPattern.test(message)
    && documentContainsVerifiableClaims(options.document)
  ) {
    plan.mcpServers.push("knowledge");
    plan.evidenceRequired = true;
  }
  if (attachmentReferencePattern.test(message)) {
    plan.mcpServers.push("knowledge");
    plan.evidenceRequired = true;
    if ((options.attachmentSourceIds?.length ?? 0) > 0) {
      plan.requiredEvidenceKinds = ["attachment_read"];
    }
  }
  if (/联网|搜索|网页|新闻|当前政策/.test(message)) {
    plan.mcpServers.push("web");
    plan.evidenceRequired = true;
    plan.requiredEvidenceKinds = [...new Set([
      ...(plan.requiredEvidenceKinds ?? []),
      "web_open" as const,
    ])];
  }
  if (/检查|审查|批评|完整/.test(message)) {
    plan.skillIds.push("lesson-critique");
    plan.specialistAgents.push("critic");
  }
  // 整份重编是一个直接生产 A4 教案的任务。不要仅因正文出现“目标、
  // 评价、知识点”等业务词就把它扩张成多 Agent 审查链。
  if (fullRewriteRequested) {
    plan.specialistAgents = [];
    plan.skillIds = [];
    const explicitlyNeedsExternalEvidence = attachmentReferencePattern.test(message)
      || /联网|搜索网页|新闻|当前政策|课程标准|课标|文献|作品原文|课文原文|出处|作者生平|事实核验|数据核验/.test(message);
    if (!explicitlyNeedsExternalEvidence) {
      plan.mcpServers = [];
      plan.evidenceRequired = false;
      plan.requiredEvidenceKinds = undefined;
    }
  }
  if (plan.minimalWriteRequested) {
    plan.specialistAgents = [];
    plan.skillIds = [];
    if (!attachmentReferencePattern.test(message) && !/联网|搜索网页|课程标准|课标|文献|作品原文|课文原文|出处|作者生平|事实核验|数据核验/.test(message)) {
      plan.mcpServers = [];
      plan.evidenceRequired = false;
      plan.requiredEvidenceKinds = undefined;
    }
  }
  return capabilityPlanSchema.parse({
    ...plan,
    skillIds: [...new Set(plan.skillIds)].slice(0, 3),
    specialistAgents: [...new Set(plan.specialistAgents)].slice(0, 3),
    mcpServers: [...new Set(plan.mcpServers)].slice(0, 2),
  });
};

export function requiresDocumentWrite(message: string) {
  if (designBasisWritePattern.test(message)) return true;
  if (explicitApprovalPattern.test(message)) return true;
  if (explicitConsultationPattern.test(message)) return false;
  const consultative = /(?:哪些|什么|是否|有没有|你认为|如何|怎么).{0,16}(?:需要|可以|值得|应该)?.{0,8}(?:优化|调整|修改|改进)/;
  if (consultative.test(message)) return false;
  return /(?:修改|更改|改写|重写|重编|编写|修订|补充|写入|替换|直接优化|优化一下|请优化|帮我优化)|提交.{0,10}(?:修改|调整|建议|确认项)|(?:生成|创建).{0,10}(?:修改|调整|确认项)/.test(message);
}

export function documentWriteMode(message: string): "consultative" | "open" | "explicit" {
  if (designBasisWritePattern.test(message)) return "explicit";
  if (explicitApprovalPattern.test(message)) return "explicit";
  if (explicitConsultationPattern.test(message)) return "consultative";
  if (requiresDocumentWrite(message)) return "explicit";
  if (/(?:哪些|什么|是否|有没有|你认为|如何|怎么|判断|检查|审查|评估)/.test(message)) {
    return "consultative";
  }
  return "open";
}

export function isConversationalControlMessage(message: string) {
  const phrases = message.trim().split(/[，,、。！!\s]+/).filter(Boolean);
  return phrases.length > 0 && phrases.every((phrase) => (
    /^(?:(?:暂时|现在|目前|先)?(?:不需要|不用|不必|算了|先这样|稍后再说|之后再说)|收到|知道了|明白了|谢谢|感谢)(?:了|你)?$/.test(
      phrase,
    )
  ));
}

export function enforceRequiredCapabilities(message: string, plan: CapabilityPlan): CapabilityPlan {
  const toolGroups = new Set(plan.toolGroups);
  toolGroups.add("document-read");
  toolGroups.add("document-write");
  return capabilityPlanSchema.parse({ ...plan, toolGroups: [...toolGroups] });
}

export function hasDeterministicRoutingSignal(plan: CapabilityPlan) {
  return plan.skillIds.length > 0
    || plan.specialistAgents.length > 0
    || plan.mcpServers.length > 0
    || plan.evidenceRequired;
}

export async function routeCapabilities(
  message: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    document?: LessonPlan;
    attachmentSourceIds?: string[];
    hasUpstreamPlanningContext?: boolean;
  } = {},
): Promise<CapabilityPlan> {
  options.signal?.throwIfAborted();
  return deterministicCapabilityPlan(message, options);
}
