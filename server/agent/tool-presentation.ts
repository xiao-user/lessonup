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
  get_document_version: "核对文档版本",
  propose_document_patch: "准备修改建议",
  lookup_curriculum_textbooks: "查找教材书目",
  search_curriculum_nodes: "检索教材篇目",
  read_curriculum_outline: "读取教材目录",
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
  ) {
    return {
      label: fallbackLabels[name],
      groupKey: "curriculum-read",
    };
  }

  return { label: fallbackLabels[name] ?? "调用备课能力" };
}
