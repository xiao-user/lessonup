import { z } from "zod";
import { parseContinuityWritebackFeedbackId } from "../curriculum/continuity-adoption.js";
import { lessonFieldSchema, type CapabilityPlan, type LessonField, type LessonPlan } from "../domain.js";

export const capabilityPlanSchema = z.object({
  skillIds: z.array(z.enum([
    "lesson-objective-review",
    "lesson-process-design",
    "lesson-assessment-alignment",
    "lesson-critique",
    "lesson-full-authoring",
    "dashi-ppt",
  ])).max(3),
  toolGroups: z.array(z.enum(["document-read", "document-write", "presentation-create"])).max(3),
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
  presentationRequested: z.boolean().default(false),
  presentationThemeConfirmationRequired: z.boolean().default(false),
  presentationThemeDismissed: z.boolean().default(false),
  confirmedPresentationTheme: z.string().regex(/^theme(?:0[1-9]|1[0-2])$/).optional(),
  reuseRecentEvidence: z.boolean().default(false),
  requestedDocumentFields: z.array(lessonFieldSchema).max(14).optional(),
  requiredEvidenceKinds: z.array(z.enum([
    "knowledge_search",
    "curriculum_standard_search",
    "knowledge_passage",
    "attachment_read",
    "source_metadata",
    "web_search",
    "web_open",
  ])).max(3).optional(),
});

const externalEvidencePattern = /教材|课标|文献|依据|来源|出处|课文原文|作品原文|古文原文|原句|引文|引用|作者|人物|生平|籍贯|朝代|年代|历史|背景|事实|数据|政策|法规|统计|定义|释义|译文|翻译|考据|真伪|是否出自|谁写|哪一年|哪一朝|最新|近期/;
const curriculumStandardPattern = /课程标准|课标/;
const recentEvidenceReusePattern = /(?:继续|接着|沿用|基于|根据).{0,16}(?:课程标准|课标|证据|资料|检索结果)|(?:刚才|上一轮|前面|前述|上述|已检索|检索到).{0,16}(?:课程标准|课标|证据|资料|内容|结果)|有检索到对应的课标内容吗/;
const attachmentReferencePattern = /附件|上传的?(?:文件|资料)|我(?:上传|提供)的?(?:文件|资料)|根据(?:这份|该|上述)?(?:文件|资料)/;
// “评价”本身也是 A4 教案的“评价练习”栏目，不能据此把一次普通
// 目标/评价对齐修改扩张成外部事实审查。只有明确的全局审查语义才
// 结合现稿中的可核事实启动知识检索。
const broadReviewPattern = /全面|整体|完整|全局|整份|通篇|审查|检查|评估/;
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
const fullRewritePattern = /重新(?:整理|编写|改写|重写|重编)|(?:整份|完整|全面).{0,10}(?:整理|重写|重编|改写|编写)|(?:整理|重编)(?:当前)?教案|把.{0,12}模板教案.{0,12}(?:转化|整理|重编|改写)/;
const classroomActionPattern = /可执行|直接实施|课堂调整|具体课时活动|学生产出|达成证据|落实到.{0,8}(?:课堂|活动)|教师动作|学生任务|可观察(?:产出|证据|表现)/;
const designBasisDeniedPattern = /(?:不要|不用|无需|不必|禁止).{0,16}(?:结构化)?设计依据|(?:结构化)?设计依据.{0,16}(?:不要|不用|无需|不必|禁止|不建立|不修改)/;
const semesterPlanningContinuityPattern = /整学期|整体教学框架|学期规划|单元规划|课时蓝图|规划.{0,12}(?:单元|课时)|生成.{0,12}蓝图|完善.{0,12}框架/;
const classroomPresentationPattern = /(?:(?:生成|创建|制作|设计|做|产出|渲染|调用).{0,16}(?:课堂)?(?:演示文稿|演示|PPT|幻灯片|Dashi))|(?:(?:课堂)?(?:演示文稿|演示|PPT|幻灯片|Dashi).{0,16}(?:生成|创建|制作|设计|做|产出|渲染|调用|Skill))|(?:直接渲染|交给\s*Dashi|调用\s*Dashi(?:\s*Skill)?)/i;
const independentSpecialistPattern = /独立(?:复核|审查|判断)|第二意见|另一个角度|多专家|专家会诊/;

const documentFieldAliases: Array<[LessonField, RegExp]> = [
  ["totalPeriods", /总课时/g],
  ["unit", /课程单元|教学单元/g],
  ["period", /(?<!总)课时(?:安排|信息|编号)?/g],
  ["topic", /课题/g],
  ["objectives", /教学目标|学习目标/g],
  ["knowledgePoints", /重点知识|知识点/g],
  ["continuity", /前后知识关联|知识关联|前后衔接/g],
  ["focus", /重点难点|教学重点(?:与|和|、)?难点|教学难点|教学重点/g],
  ["preparation", /教学准备/g],
  ["process", /教学过程|课堂过程/g],
  ["assessment", /评价练习|评价设计|课堂评价/g],
  ["homework", /作业设计|课后作业/g],
  ["board", /板书设计|课堂板书/g],
  ["reflection", /教学反思|课后反思/g],
];
const documentWriteVerbPattern = /修改|更改|改写|重写|重编|编写|修订|补充|优化|完善|调整|替换|写入|写成|改成|改为|落实/;
const deicticDocumentTargetPattern = /这一处|这处|这里|当前栏目|这个栏目|选中(?:内容|文字|部分)?|这段|这句/;

/**
 * Resolve only the teacher's requested write targets. Mentioned evidence or
 * context fields are intentionally excluded so read scope can remain broader.
 */
export function requestedDocumentFieldsFor(
  message: string,
  options: { activeSectionId?: string; selectionField?: LessonField } = {},
): LessonField[] | undefined {
  if (fullRewritePattern.test(message) || !requiresDocumentWrite(message)) return undefined;
  const targets: LessonField[] = [];
  for (const [field, pattern] of documentFieldAliases) {
    pattern.lastIndex = 0;
    for (const match of message.matchAll(pattern)) {
      const index = match.index ?? 0;
      const matched = match[0];
      const before = message.slice(Math.max(0, index - 18), index);
      const after = message.slice(index + matched.length, index + matched.length + 18);
      const beforeClause = before.slice(Math.max(
        before.lastIndexOf("，"),
        before.lastIndexOf("。"),
        before.lastIndexOf("；"),
        before.lastIndexOf(";"),
      ) + 1);
      const introducedAsEvidence = /(?:依据|根据|结合|参考|基于|对照)[^，。；;]{0,8}$/.test(beforeClause)
        && !/(?:把|将)[^，。；;]{0,8}$/.test(beforeClause);
      if (introducedAsEvidence) continue;
      const verbImmediatelyAfter = /^(?:栏(?:目)?|中|里|内容|部分)?(?:进行)?(?:修改|更改|改写|重写|重编|编写|修订|补充|优化|完善|调整|替换|写入|写成|改成|改为|落实)/.test(after);
      if (documentWriteVerbPattern.test(beforeClause) || verbImmediatelyAfter) {
        targets.push(field);
        break;
      }
    }
  }
  if (!targets.length && deicticDocumentTargetPattern.test(message)) {
    if (options.selectionField) targets.push(options.selectionField);
    else {
      const active = lessonFieldSchema.safeParse(options.activeSectionId);
      if (active.success) targets.push(active.data);
    }
  }
  return targets.length ? [...new Set(targets)] : undefined;
}

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
    activeSectionId?: string;
    selectionField?: LessonField;
  } = {},
): CapabilityPlan => {
  const fullRewriteRequested = fullRewritePattern.test(message);
  const designBasisDenied = designBasisDeniedPattern.test(message);
  const writebackFeedbackId = parseContinuityWritebackFeedbackId(message);
  const lightweightConversation = !writebackFeedbackId && isConversationalControlMessage(message);
  const presentationRequested = classroomPresentationPattern.test(message);
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
    presentationRequested,
    reuseRecentEvidence: recentEvidenceReusePattern.test(message),
    requestedDocumentFields: fullRewriteRequested
      ? undefined
      : requestedDocumentFieldsFor(message, options),
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
  if (presentationRequested) {
    return capabilityPlanSchema.parse({
      ...plan,
      skillIds: ["dashi-ppt"],
      toolGroups: ["presentation-create"],
      mcpServers: [],
      specialistAgents: [],
      evidenceRequired: false,
      writeMode: "consultative",
      requestedDocumentFields: undefined,
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
    if (independentSpecialistPattern.test(message)) plan.specialistAgents.push("curriculum-analysis");
  }
  if (/过程|活动|问题链|板书|作业/.test(message)) {
    plan.skillIds.push("lesson-process-design");
    if (independentSpecialistPattern.test(message)) plan.specialistAgents.push("learning-design");
  }
  if (/评价|练习|达成|一致性/.test(message)) {
    plan.skillIds.push("lesson-assessment-alignment");
    if (independentSpecialistPattern.test(message)) plan.specialistAgents.push("assessment");
  }
  if (externalEvidenceRequest) {
    plan.mcpServers.push("knowledge");
    plan.evidenceRequired = true;
  }
  if (curriculumStandardPattern.test(message)) {
    plan.mcpServers.push("knowledge");
    plan.evidenceRequired = true;
    plan.requiredEvidenceKinds = [...new Set([
      ...(plan.requiredEvidenceKinds ?? []),
      "curriculum_standard_search" as const,
    ])];
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
    if (independentSpecialistPattern.test(message)) plan.specialistAgents.push("critic");
  }
  // 整份重编是一个直接生产 A4 教案的任务。不要仅因正文出现“目标、
  // 评价、知识点”等业务词就把它扩张成多 Agent 审查链。
  if (fullRewriteRequested) {
    plan.specialistAgents = [];
    plan.skillIds = ["lesson-full-authoring"];
    const explicitlyNeedsExternalEvidence = attachmentReferencePattern.test(message)
      || /联网|搜索网页|新闻|当前政策|课程标准|课标|文献|作品原文|课文原文|出处|作者生平|事实核验|数据核验/.test(message);
    // A complete lesson must be aligned with the published standard even when
    // the teacher does not repeat the word “课标” in every generation request.
    // The MCP itself binds subject/stage/grade, and its exact fresh result can
    // be reused across turns without another embedding call.
    plan.mcpServers = [...new Set([...plan.mcpServers, "knowledge"])];
    plan.evidenceRequired = true;
    plan.requiredEvidenceKinds = [...new Set([
      ...(plan.requiredEvidenceKinds ?? []),
      "curriculum_standard_search" as const,
    ])];
    if (!explicitlyNeedsExternalEvidence) {
      plan.mcpServers = ["knowledge"];
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
  return /(?:修改|更改|改成|改写|重写|重编|编写|修订|补充|写入|替换|直接优化|优化一下|请优化|帮我优化|(?:重新)?整理(?:当前|整份|完整)?教案)|提交.{0,10}(?:修改|调整|建议|确认项)|(?:生成|创建).{0,10}(?:修改|调整|确认项)/.test(message);
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
  const normalized = message.trim().toLowerCase();
  if (/^(?:ok(?:ay)?|thanks|thank you|got it|understood|sounds good|no thanks|not now)[.!]?$/i.test(normalized)) {
    return true;
  }
  const phrases = normalized.split(/[，,、。！!\s]+/).filter(Boolean);
  return phrases.length > 0 && phrases.every((phrase) => (
    /^(?:(?:暂时|现在|目前|先)?(?:不需要|不用|不必|算了|先这样|稍后再说|之后再说)|好|好的|没问题|收到|知道了|明白了|谢谢|感谢)(?:了|你)?$/.test(
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
    activeSectionId?: string;
    selectionField?: LessonField;
  } = {},
): Promise<CapabilityPlan> {
  options.signal?.throwIfAborted();
  return deterministicCapabilityPlan(message, options);
}
