export const lessonPlanSections = [
  { id: "basics", label: "基本信息", tone: "teal" },
  { id: "objectives", label: "教学目标", tone: "olive" },
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
    unit: options.unitTitle?.trim() || `${notebook.subject}课程单元`,
    period: "第 1 课时",
    totalPeriods: "2 课时",
    topic: options.lessonTitle?.trim() || file.title,
    objectives: "1. 理解本课核心概念，并能够用自己的语言进行解释。\n2. 在观察、比较与讨论中形成解决问题的方法。\n3. 能够将所学内容迁移到新的学习情境中。",
    focus: "教学重点：理解核心概念之间的关系，并能够准确表达。\n教学难点：从具体情境中抽象方法，并完成迁移应用。",
    preparation: "教师：课件、示例材料与课堂任务单。\n学生：预习教材，准备学习用品并记录已有问题。",
    process: "一、情境导入（5 分钟）\n从学生熟悉的现象切入，提出本课核心问题。\n\n二、探究新知（20 分钟）\n学生观察材料、独立思考并在小组内交流；教师通过递进问题帮助学生建立概念联系。\n\n三、巩固应用（12 分钟）\n完成基础任务与迁移任务，结合典型错误进行即时反馈。\n\n四、课堂小结（3 分钟）\n学生回顾学习路径，归纳本课的关键方法。",
    assessment: "通过课堂表达、任务完成情况和迁移练习观察学习目标的达成度；针对不同表现给予即时反馈。",
    homework: "基础任务：完成教材对应练习。\n拓展任务：选择一个真实情境，说明本课方法如何应用其中。",
    board: `${file.title}\n核心概念 → 关键关系 → 解决方法 → 迁移应用`,
    reflection: "课后记录目标达成情况、学生生成的问题，以及下一课时需要调整的教学环节。",
  };
}
