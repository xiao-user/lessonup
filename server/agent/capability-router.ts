import { z } from "zod";
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

function documentContainsVerifiableClaims(document?: LessonPlan) {
  return document
    ? externalEvidencePattern.test(Object.values(document).join("\n"))
    : false;
}

export const deterministicCapabilityPlan = (
  message: string,
  options: { document?: LessonPlan; attachmentSourceIds?: string[] } = {},
): CapabilityPlan => {
  const plan: CapabilityPlan = {
    skillIds: [],
    toolGroups: ["document-read", "document-write"],
    mcpServers: [],
    specialistAgents: [],
    evidenceRequired: false,
  };
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
  if (externalEvidencePattern.test(message)) {
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
  }
  if (/检查|审查|批评|完整/.test(message)) {
    plan.skillIds.push("lesson-critique");
    plan.specialistAgents.push("critic");
  }
  return capabilityPlanSchema.parse({
    ...plan,
    skillIds: [...new Set(plan.skillIds)].slice(0, 3),
    specialistAgents: [...new Set(plan.specialistAgents)].slice(0, 3),
    mcpServers: [...new Set(plan.mcpServers)].slice(0, 2),
  });
};

export function requiresDocumentWrite(message: string) {
  const consultative = /(?:哪些|什么|是否|有没有|你认为|如何|怎么).{0,16}(?:需要|可以|值得|应该)?.{0,8}(?:优化|调整|修改|改进)/;
  if (consultative.test(message)) return false;
  return /(?:修改|更改|改写|重写|修订|补充|写入|替换|提交修改|生成修改|直接优化|优化一下|请优化|帮我优化)/.test(message);
}

export function isConversationalControlMessage(message: string) {
  const phrases = message.trim().split(/[，,、。！!\s]+/).filter(Boolean);
  return phrases.length > 0 && phrases.every((phrase) => (
    /^(?:暂时|现在|目前|先)?(?:不需要|不用|不必|算了|先这样|稍后再说|之后再说|好的?|可以|收到|知道了|明白了|谢谢|感谢)(?:了|你)?$/.test(
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
  } = {},
): Promise<CapabilityPlan> {
  options.signal?.throwIfAborted();
  return deterministicCapabilityPlan(message, options);
}
