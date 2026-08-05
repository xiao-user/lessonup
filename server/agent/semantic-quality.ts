import type { LessonPlan } from "../domain.js";

export type LessonSemanticQualityPrediction = {
  passed: boolean;
  score: number;
  issues: string[];
};

const genericPhrases = [
  "理解本课核心概念",
  "形成解决问题的方法",
  "完成基础任务与迁移任务",
  "将所学内容迁移到新的学习情境",
  "从学生熟悉的现象切入",
  "结合典型错误进行即时反馈",
];

const observableActionPattern = /(?:说出|写出|圈画|标注|填写|完成|概括|比较|分类|朗读|复述|说明|解释|分析|判断|展示|提交|创作|修改|互评)/;
const learnerActionPattern = /(?:学生|小组|同桌|个人|全班).{0,24}(?:说出|写出|圈画|标注|填写|完成|概括|比较|分类|朗读|复述|说明|解释|分析|判断|展示|提交|讨论|互评)/s;
const criterionPattern = /(?:正确|准确|至少|能够|是否|达到|完成度|依据|标准|要点|证据|表现|结果|作品|任务单|出口条|评价量表)/;

/**
 * Fast prediction for obviously unusable full-lesson drafts. It rejects only
 * high-confidence failures; nuanced pedagogy remains an offline business eval
 * so teacher approvals do not pay for another model request.
 */
export function predictLessonSemanticQuality(
  plan: LessonPlan,
  options: { lessonDurationMinutes?: number } = {},
): LessonSemanticQualityPrediction {
  const issues: string[] = [];
  const coreFields: Array<keyof LessonPlan> = [
    "objectives", "knowledgePoints", "focus", "process", "assessment",
  ];
  if (coreFields.some((field) => !plan[field].trim())) issues.push("missing_core_content");

  const instructionalText = coreFields.map((field) => plan[field]).join("\n");
  if (genericPhrases.some((phrase) => instructionalText.includes(phrase))) {
    issues.push("generic_reusable_content");
  }
  if (plan.process.trim().length < 120) issues.push("process_too_thin");
  if (!learnerActionPattern.test(plan.process)) issues.push("learner_action_missing");
  if (!observableActionPattern.test(plan.assessment) || !criterionPattern.test(plan.assessment)) {
    issues.push("assessment_evidence_missing");
  }
  if (options.lessonDurationMinutes) {
    const periodHeadings = [...plan.process.matchAll(
      /第(?:[一二三四五六七八九十\d]+)课时[^\n]{0,24}?(\d{1,3})\s*分钟/g,
    )].map((match) => Number(match[1]));
    const allDurations = [...plan.process.matchAll(/(\d{1,3})\s*分钟/g)]
      .map((match) => Number(match[1]));
    const plannedMinutes = periodHeadings.length ? periodHeadings : allDurations;
    const total = plannedMinutes.reduce((sum, minutes) => sum + minutes, 0);
    if (total > options.lessonDurationMinutes * 1.15) {
      issues.push("duration_exceeds_context");
    }
  }

  return {
    passed: issues.length === 0,
    score: Math.max(0, 1 - issues.length / 5),
    issues,
  };
}

export function semanticQualityGuidance(issues: string[]) {
  const labels: Record<string, string> = {
    missing_core_content: "目标、重点知识、重点难点、过程或评价仍有空栏",
    generic_reusable_content: "仍包含可替换到任意课题的通用表述",
    process_too_thin: "教学过程不足以支撑一节可直接实施的课",
    learner_action_missing: "教学过程缺少明确的学生任务与可观察动作",
    assessment_evidence_missing: "评价练习缺少可观察任务或判断标准",
    duration_exceeds_context: "教学过程中的明确时间安排超过了当前课时长度",
  };
  return `完整教案的语义质量预检未通过：${issues.map((issue) => labels[issue] ?? issue).join("；")}。请基于当前课题和已读知识点补齐具体内容后，只修正并重新提交一次。`;
}
