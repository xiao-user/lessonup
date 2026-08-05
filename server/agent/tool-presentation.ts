import type { LessonField } from "../domain.js";

export type SafeToolPresentation = {
  label: string;
  groupKey?: string;
};

export const lessonFieldLabels: Record<LessonField, string> = {
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

const fallbackLabels: Record<string, string> = {
  read_document_metadata: "读取教案信息",
  read_document: "读取整份教案",
  read_section: "读取教案栏目",
  read_document_outline: "检查教案结构",
  propose_document_patch: "准备修改建议",
  read_lesson_design_basis: "读取教案设计依据",
  propose_lesson_design_change: "准备完整备课调整",
  propose_design_basis_projection: "准备将设计依据落实到教案",
  propose_lesson_design_basis_patch: "准备设计依据修改",
  read_semester_framework: "读取学期框架",
  read_semester_unit: "读取单元计划",
  read_semester_framework_continuity: "核对学期教学连续性",
  get_semester_framework_version: "核对框架版本",
  propose_semester_framework_patch: "准备框架修改建议",
  lookup_curriculum_textbooks: "查找教材书目",
  search_curriculum_nodes: "检索教材篇目",
  read_curriculum_outline: "读取教材目录",
  read_curriculum_node_semantics: "读取章节学习要点",
  trace_curriculum_learning_path: "梳理前后学习路径",
  read_curriculum_knowledge_points: "读取章节知识点",
  search_curriculum_knowledge_points: "检索相关知识点",
  read_curriculum_knowledge_continuity: "核对知识连续性",
  search_knowledge: "检索备课资料",
  read_attached_source: "读取附带资料",
  get_passage: "读取资料片段",
  get_source: "核对资料来源",
  list_project_sources: "读取项目资料",
  search_web: "联网搜索",
  open_web_result: "读取网页",
  curriculum_analysis: "分析课程与目标",
  learning_design: "设计学习过程",
  assessment: "检查教学评一致性",
  critic: "检查教案",
};

const parseArguments = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const fieldLabel = (value: unknown) => (
  typeof value === "string" && value in lessonFieldLabels
    ? lessonFieldLabels[value as LessonField]
    : undefined
);

export function safeToolPresentation(
  name: string,
  rawArguments?: unknown,
): SafeToolPresentation {
  const args = parseArguments(rawArguments);

  if (name === "read_section") {
    const label = fieldLabel(args.field);
    return {
      label: label ? `读取${label}` : fallbackLabels.read_section,
      groupKey: "document-read",
    };
  }

  if (name === "read_document") {
    const fields = Array.isArray(args.fields)
      ? [...new Set(args.fields.map(fieldLabel).filter(Boolean))]
      : [];
    if (fields.length === 1) {
      return { label: `读取${fields[0]}`, groupKey: "document-read" };
    }
    if (fields.length > 1) {
      return { label: `读取 ${fields.length} 个教案栏目`, groupKey: "document-read" };
    }
    return { label: fallbackLabels.read_document, groupKey: "document-read" };
  }

  if (name === "read_attached_source") {
    return { label: fallbackLabels.read_attached_source, groupKey: "knowledge-read" };
  }

  if (
    name === "lookup_curriculum_textbooks"
    || name === "search_curriculum_nodes"
    || name === "read_curriculum_outline"
    || name === "read_curriculum_node_semantics"
    || name === "trace_curriculum_learning_path"
    || name === "read_curriculum_knowledge_points"
    || name === "search_curriculum_knowledge_points"
    || name === "read_curriculum_knowledge_continuity"
  ) {
    return {
      label: fallbackLabels[name],
      groupKey: "curriculum-read",
    };
  }

  if (
    name === "read_semester_framework"
    || name === "read_semester_unit"
    || name === "read_semester_framework_continuity"
    || name === "get_semester_framework_version"
  ) {
    return { label: fallbackLabels[name], groupKey: "framework-read" };
  }
  if (name === "propose_semester_framework_patch") {
    return { label: fallbackLabels[name], groupKey: "framework-write" };
  }
  if (name === "read_lesson_design_basis") {
    return { label: fallbackLabels[name], groupKey: "design-basis-read" };
  }
  if (name === "propose_lesson_design_basis_patch") {
    return { label: fallbackLabels[name], groupKey: "design-basis-write" };
  }
  if (name === "propose_lesson_design_change") {
    return { label: fallbackLabels[name], groupKey: "document-write" };
  }
  if (name === "propose_design_basis_projection") {
    return { label: fallbackLabels[name], groupKey: "document-write" };
  }

  return { label: fallbackLabels[name] ?? "调用备课能力" };
}
