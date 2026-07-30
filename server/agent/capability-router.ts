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

const fallbackPlan = (message: string): CapabilityPlan => {
  const plan: CapabilityPlan = {
    skillIds: [],
    toolGroups: ["document-read"],
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
  if (/修改|改写|补充|写入|替换|优化/.test(message)) plan.toolGroups.push("document-write");
  if (/资料|教材|课标|文献/.test(message)) plan.mcpServers.push("knowledge");
  if (/联网|最新|搜索|网页/.test(message)) plan.mcpServers.push("web");
  if (/检查|审查|批评|完整/.test(message)) {
    plan.skillIds.push("lesson-critique");
    plan.specialistAgents.push("critic");
  }
  return capabilityPlanSchema.parse(plan);
};

export function enforceRequiredCapabilities(message: string, plan: CapabilityPlan): CapabilityPlan {
  const toolGroups = new Set(plan.toolGroups);
  if (/修改|改写|补充|写入|替换|优化/.test(message)) toolGroups.add("document-write");
  return capabilityPlanSchema.parse({ ...plan, toolGroups: [...toolGroups] });
}

export async function routeCapabilities(message: string): Promise<CapabilityPlan> {
  const client = createDeepSeekClient();
  try {
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
            "遵循最小能力原则；普通问答只选 document-read。",
          ].join("\n"),
        },
        { role: "user", content: message },
      ],
    });
    const plan = capabilityPlanSchema.parse(JSON.parse(response.choices[0]?.message?.content ?? "{}"));
    return enforceRequiredCapabilities(message, plan);
  } catch {
    return fallbackPlan(message);
  }
}
