export const lessonFieldLabels = {
  unit: "课程单元",
  period: "课时",
  totalPeriods: "总课时",
  topic: "课题",
  objectives: "教学目标",
  knowledgePoints: "重点知识",
  continuity: "前后知识关联",
  focus: "重点难点",
  preparation: "教学准备",
  process: "教学过程",
  assessment: "评价练习",
  homework: "作业设计",
  board: "板书设计",
  reflection: "教学反思",
};

export const frameworkFieldLabels = {
  title: "框架名称",
  term: "学期",
  startDate: "开学日期",
  totalWeeks: "教学周数",
  weeklyPeriods: "每周课时",
  lessonDurationMinutes: "每课时分钟",
  capacityRatio: "课堂容量系数",
  planningHorizonWeeks: "滚动备课周数",
  contextProfile: "班级教学情境",
  status: "框架状态",
};

export const semesterUnitFieldLabels = {
  plannedStartWeek: "起始周",
  plannedEndWeek: "结束周",
  plannedPeriods: "计划课时",
  learningGoals: "单元目标",
  teacherNotes: "教师备注",
  status: "单元状态",
};

export const lessonBlueprintFieldLabels = {
  curriculumNodeId: "教材章节",
  title: "课时名称",
  mainActivity: "主要教学活动",
  observableProduct: "学生可观察产出",
  assessmentEvidence: "达成证据",
  anticipatedDifficulties: "预判难点",
  plannedMinutes: "课堂分钟",
  teacherNotes: "蓝图备注",
  status: "蓝图状态",
};

export const lessonDesignBasisFieldLabels = {
  learnerContext: "学生与课堂条件",
  teacherNotes: "设计依据备注",
  status: "设计依据状态",
};

export const lessonDesignBasisEntryFieldLabels = {
  statement: "教学结论",
  rationale: "判断依据",
  evidence: "证据来源",
  decision: "教师决定",
};

export const lessonDesignBasisEntryKindLabels = {
  knowledge_point: "本课知识点",
  review: "复习旧知",
  prepare: "后续铺垫",
  student_difficulty: "学生困难",
  assessment_evidence: "评价证据",
  teaching_decision: "教学决定",
};

function presentBlueprint(operation) {
  return [
    operation.title,
    `主要活动：${operation.mainActivity}`,
    `学生产出：${operation.observableProduct}`,
    `达成证据：${operation.assessmentEvidence}`,
    operation.plannedMinutes ? `计划用时：${operation.plannedMinutes} 分钟` : null,
  ].filter(Boolean).join("\n");
}

function presentResourceValue(value) {
  if (value === null || value === undefined || value === "") return "（未设置）";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return JSON.stringify(value, null, 2);
}

function changedWindow(before, after, contextLength = 72) {
  let prefix = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < suffixLimit
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  const prefixContext = before.slice(Math.max(0, prefix - contextLength), prefix);
  const suffixContext = before.slice(
    before.length - suffix,
    Math.min(before.length, before.length - suffix + contextLength),
  );
  return {
    before: `${prefix > contextLength ? "…" : ""}${prefixContext}${before.slice(prefix, before.length - suffix)}${suffixContext}${suffix > contextLength ? "…" : ""}`,
    after: `${prefix > contextLength ? "…" : ""}${prefixContext}${after.slice(prefix, after.length - suffix)}${suffixContext}${suffix > contextLength ? "…" : ""}`,
  };
}

export function presentPatchOperation(operation) {
  if (operation.op === "create_design_basis_entry") {
    const after = [
      operation.statement,
      operation.rationale ? `依据：${operation.rationale}` : null,
    ].filter(Boolean).join("\n");
    return {
      fieldLabel: `新增${lessonDesignBasisEntryKindLabels[operation.kind] ?? "设计依据"}`,
      targetKind: "design-basis",
      isNoEffect: false,
      before: "（尚未记录）",
      after,
      fullBefore: "（尚未记录）",
      fullAfter: after,
      isTruncated: false,
    };
  }
  if (operation.op === "delete_design_basis_entry") {
    const before = `${operation.expectedStatement ?? "当前设计依据"}（版本 V${operation.expectedVersion}）`;
    return {
      fieldLabel: "删除设计依据",
      targetKind: "design-basis",
      isNoEffect: false,
      before,
      after: "删除这条已记录的教学判断",
      fullBefore: before,
      fullAfter: "删除这条已记录的教学判断",
      isTruncated: false,
    };
  }
  if (
    operation.op === "replace_design_basis_field"
    || operation.op === "replace_design_basis_entry_field"
  ) {
    const before = presentResourceValue(operation.expectedValue);
    const after = presentResourceValue(operation.replacement);
    const compact = before.length <= 280 && after.length <= 280;
    const labels = operation.op === "replace_design_basis_field"
      ? lessonDesignBasisFieldLabels
      : lessonDesignBasisEntryFieldLabels;
    return {
      fieldLabel: labels[operation.field] ?? "教案设计依据",
      targetKind: "design-basis",
      isNoEffect: before === after,
      before: compact ? before : changedWindow(before, after).before,
      after: compact ? after : changedWindow(before, after).after,
      fullBefore: before,
      fullAfter: after,
      isTruncated: !compact,
    };
  }
  if (operation.op === "create_lesson_blueprint") {
    const after = presentBlueprint(operation);
    return {
      fieldLabel: `新增第 ${operation.plannedPeriod} 课时蓝图`,
      targetKind: "blueprint",
      isNoEffect: false,
      before: "（尚未创建）",
      after,
      fullBefore: "（尚未创建）",
      fullAfter: after,
      isTruncated: false,
    };
  }
  if (operation.op === "delete_lesson_blueprint") {
    const before = `${operation.expectedTitle ?? "当前课时蓝图"}（版本 V${operation.expectedVersion}）`;
    const after = "删除蓝图，并移除其关联的知识点选择";
    return {
      fieldLabel: "删除课时蓝图",
      targetKind: "blueprint",
      isNoEffect: false,
      before,
      after,
      fullBefore: before,
      fullAfter: after,
      isTruncated: false,
    };
  }
  if (operation.op === "replace_lesson_blueprint_field") {
    const before = presentResourceValue(operation.expectedValue);
    const after = presentResourceValue(operation.replacement);
    const compact = before.length <= 280 && after.length <= 280;
    return {
      fieldLabel: lessonBlueprintFieldLabels[operation.field] ?? "课时蓝图",
      targetKind: "blueprint",
      isNoEffect: before === after,
      before: compact ? before : changedWindow(before, after).before,
      after: compact ? after : changedWindow(before, after).after,
      fullBefore: before,
      fullAfter: after,
      isTruncated: !compact,
    };
  }
  if (operation.op === "replace_framework_field" || operation.op === "replace_unit_field") {
    const before = presentResourceValue(operation.expectedValue);
    const after = presentResourceValue(operation.replacement);
    const compact = before.length <= 280 && after.length <= 280;
    const labels = operation.op === "replace_framework_field"
      ? frameworkFieldLabels
      : semesterUnitFieldLabels;
    return {
      fieldLabel: labels[operation.field] ?? "框架字段",
      targetKind: operation.op === "replace_framework_field" ? "framework" : "unit",
      isNoEffect: before === after,
      before: compact ? before : changedWindow(before, after).before,
      after: compact ? after : changedWindow(before, after).after,
      fullBefore: before,
      fullAfter: after,
      isTruncated: !compact,
    };
  }
  const before = operation.expectedText;
  const after = operation.replacement;
  const compact = before.length <= 280 && after.length <= 280;
  return {
    fieldLabel: lessonFieldLabels[operation.field] ?? "教案栏目",
    isNoEffect: before === after,
    before: compact ? before : changedWindow(before, after).before,
    after: compact ? after : changedWindow(before, after).after,
    fullBefore: before,
    fullAfter: after,
    isTruncated: !compact,
  };
}
