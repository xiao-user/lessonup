import { describe, expect, it } from "vitest";
import type { LessonPlan } from "../domain.js";
import { predictLessonSemanticQuality } from "./semantic-quality.js";

const concretePlan: LessonPlan = {
  unit: "第一单元", period: "第1课时", totalPeriods: "共2课时", topic: "《春》",
  objectives: "学生能圈画春草图中的动词和叠词，并结合语境说明表达效果。",
  knowledgePoints: "写景词语的语境表达效果；朗读中的重音与停连。",
  continuity: "复习词语语境义，为后续写景片段中的准确用词铺垫。",
  focus: "结合具体语句分析动词、形容词和叠词的表达效果。",
  preparation: "课文与五幅春景图任务单。",
  process: "教师出示春草图片并范读第3段。学生个人圈画‘偷偷地、钻、嫩嫩的、绿绿的’，同桌比较替换前后的表达差异；小组在任务单上写出词语、景物特点和表达效果，并用课文原句说明依据。每组展示一项判断，其他学生依据‘词语—特点—效果—原文’四项标准互评，教师只对证据不足处追问。最后学生独立朗读并标注重音与停连。",
  assessment: "出口条：学生写出一个关键词语及其表达效果，并引用原句作为依据；四项中正确完成三项即达成。",
  homework: "仿写一段春景。", board: "词语→景物特点→表达效果→原文依据",
  reflection: "课后记录学生证据使用情况。",
};

describe("lesson semantic quality prediction", () => {
  it("accepts a concrete and observable lesson", () => {
    expect(predictLessonSemanticQuality(concretePlan)).toMatchObject({
      passed: true, score: 1, issues: [],
    });
  });

  it("rejects a generic template before it reaches teacher approval", () => {
    const prediction = predictLessonSemanticQuality({
      ...concretePlan,
      objectives: "理解本课核心概念，并形成解决问题的方法。",
      process: "从学生熟悉的现象切入，完成基础任务与迁移任务。",
      assessment: "根据课堂表现进行评价。",
    });
    expect(prediction.passed).toBe(false);
    expect(prediction.issues).toEqual(expect.arrayContaining([
      "generic_reusable_content", "process_too_thin",
      "assessment_evidence_missing",
    ]));
  });

  it("rejects a two-period draft when the current blueprint allows one period", () => {
    const prediction = predictLessonSemanticQuality({
      ...concretePlan,
      process: `【第一课时（60分钟）】\n${concretePlan.process}\n【第二课时（60分钟）】\n${concretePlan.process}`,
    }, { lessonDurationMinutes: 60 });

    expect(prediction.issues).toContain("duration_exceeds_context");
  });
});
