export const lessonPlanSections = [
  { id: "basics", label: "基本信息", tone: "teal" },
  { id: "objectives", label: "教学目标", tone: "olive" },
  { id: "knowledgePoints", label: "重点知识", tone: "highlight" },
  { id: "continuity", label: "前后知识关联", tone: "teal" },
  { id: "focus", label: "重点难点", tone: "sand" },
  { id: "preparation", label: "教学准备", tone: "rose" },
  { id: "process", label: "教学过程", tone: "teal" },
  { id: "assessment", label: "评价练习", tone: "olive" },
  { id: "homework", label: "作业设计", tone: "sand" },
  { id: "board", label: "板书设计", tone: "rose" },
  { id: "reflection", label: "教学反思", tone: "ink" },
];

export const assistantSuggestions = {
  basics: ["梳理课时信息", "补充课程标准依据", "检查课题表述"],
  objectives: ["检查目标是否可评价", "补充核心素养目标", "改写为学生视角"],
  knowledgePoints: ["核对本课重点知识", "区分复习与新授", "检查后续铺垫"],
  continuity: ["判断需要复习的旧知", "明确为后续课程做什么铺垫", "把衔接落实到课堂活动"],
  focus: ["识别学生常见误区", "拆分重点与难点", "给出突破难点的方法"],
  preparation: ["生成材料清单", "补充数字化资源", "检查课堂准备遗漏"],
  process: ["设计课堂提问链", "补充学生活动", "优化各环节时间分配"],
  assessment: ["生成分层练习", "设计课堂观察点", "补充形成性评价"],
  homework: ["生成分层作业", "控制作业时长", "补充实践型任务"],
  board: ["精简板书结构", "生成板书层级", "突出核心概念关系"],
  reflection: ["整理课堂观察", "提炼改进建议", "生成课后复盘问题"],
};

export function createLessonPlanDraft(notebook, file, options = {}) {
  return {
    unit: options.unitTitle?.trim() || "",
    period: options.period?.trim() || "第 1 课时",
    totalPeriods: options.totalPeriods?.trim() || "",
    topic: options.lessonTitle?.trim() || file.title,
    objectives: options.objectives?.trim() || "",
    knowledgePoints: options.knowledgePoints?.trim() || "",
    continuity: options.continuity?.trim() || "",
    focus: options.focus?.trim() || "",
    preparation: options.preparation?.trim() || "",
    process: options.mainActivity?.trim() || "",
    assessment: options.assessmentEvidence?.trim() || "",
    homework: options.homework?.trim() || "",
    board: options.board?.trim() || "",
    reflection: options.reflection?.trim() || "",
  };
}
