import { z } from "zod";
import { createDeepSeekClient, deepSeekModels } from "./deepseek-provider.js";
import type { CapabilityPlan } from "../domain.js";

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
});

export const deterministicCapabilityPlan = (message: string): CapabilityPlan => {
  const plan: CapabilityPlan = {
    skillIds: [],
    toolGroups: ["document-read", "document-write"],
    mcpServers: [],
    specialistAgents: [],
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
  if (/资料|教材|课标|文献/.test(message)) plan.mcpServers.push("knowledge");
  if (/联网|最新|搜索|网页/.test(message)) plan.mcpServers.push("web");
  if (/检查|审查|批评|完整/.test(message)) {
    plan.skillIds.push("lesson-critique");
    plan.specialistAgents.push("critic");
  }
  return capabilityPlanSchema.parse({
    ...plan,
    skillIds: [...new Set(plan.skillIds)].slice(0, 3),
    specialistAgents: [...new Set(plan.specialistAgents)].slice(0, 3),
  });
};

export function requiresDocumentWrite(message: string) {
  const consultative = /(?:哪些|什么|是否|有没有|你认为|如何|怎么).{0,16}(?:需要|可以|值得|应该)?.{0,8}(?:优化|调整|修改|改进)/;
  if (consultative.test(message)) return false;
  return /(?:修改|更改|改写|重写|修订|补充|写入|替换|提交修改|生成修改|直接优化|优化一下|请优化|帮我优化)/.test(message);
}

export function enforceRequiredCapabilities(message: string, plan: CapabilityPlan): CapabilityPlan {
  const toolGroups = new Set(plan.toolGroups);
  toolGroups.add("document-read");
  toolGroups.add("document-write");
  return capabilityPlanSchema.parse({ ...plan, toolGroups: [...toolGroups] });
}

export async function routeCapabilities(
  message: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CapabilityPlan> {
  if (requiresDocumentWrite(message)) return deterministicCapabilityPlan(message);
  const client = createDeepSeekClient();
  try {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 3_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await client.chat.completions.create({
      model: deepSeekModels.flash,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是 LessonUp 能力路由器，只输出 JSON。",
            "skillIds 可选 lesson-objective-review, lesson-process-design, lesson-assessment-alignment, lesson-critique。",
            "toolGroups 可选 document-read, document-write。",
            "mcpServers 可选 knowledge, web。",
            "specialistAgents 可选 curriculum-analysis, learning-design, assessment, critic。",
            "document-read 与 document-write 是统一备课助手的标准工具，始终选择两者；写入工具仍需要用户审批。",
          ].join("\n"),
        },
        { role: "user", content: message },
      ],
    }, { signal });
    const plan = capabilityPlanSchema.parse(JSON.parse(response.choices[0]?.message?.content ?? "{}"));
    return enforceRequiredCapabilities(message, plan);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return deterministicCapabilityPlan(message);
  }
}
