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
  complete_without_change: "说明保留现稿或证据缺口",
  read_learning_progress: "读取学习证据与改进记录",
  propose_learning_inquiry: "准备学习改进方案",
  propose_learning_review: "准备复测审议建议",
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
  read_framework_class_feedback: "读取课堂反馈",
  read_lesson_class_feedback: "读取本课与前序课堂反馈",
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
  search_curriculum_standards: "检索当前学科课标",
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
  create_classroom_presentation: "创建课堂演示",
  propose_classroom_presentation: "准备 Dashi 最终演示",
  query_dashi_layouts: "规划 Dashi 版式",
  inspect_dashi_layouts: "核对 Dashi 版式",
  render_dashi_presentation: "生成课堂演示",
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
    || name === "search_curriculum_standards"
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
    || name === "read_framework_class_feedback"
    || name === "read_lesson_class_feedback"
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
  if (name === "create_classroom_presentation") {
    return { label: fallbackLabels[name], groupKey: "presentation-create" };
  }
  if (name === "propose_classroom_presentation") {
    return { label: fallbackLabels[name], groupKey: "presentation-create" };
  }
  if (name === "query_dashi_layouts" || name === "inspect_dashi_layouts") {
    return { label: fallbackLabels[name], groupKey: "presentation-create" };
  }
  if (name === "render_dashi_presentation") {
    return { label: fallbackLabels[name], groupKey: "presentation-create" };
  }

  return { label: fallbackLabels[name] ?? "调用备课能力" };
}

/** A public purpose summary for the activity row; never includes raw tool output or identifiers. */
export function safeToolDetail(name: string, rawArguments?: unknown): string {
  const args = parseArguments(rawArguments);

  if (name === "read_section") {
    const label = fieldLabel(args.field) ?? "目标栏目";
    return `读取${label}的当前内容，作为后续分析与修改依据。`;
  }
  if (name === "read_document") {
    const fields = Array.isArray(args.fields)
      ? [...new Set(args.fields.map(fieldLabel).filter(Boolean))]
      : [];
    if (fields.length === 1) return `读取${fields[0]}的当前内容，作为后续分析与修改依据。`;
    if (fields.length > 1) return `读取当前教案的 ${fields.length} 个栏目，作为后续分析与修改依据。`;
    return "读取当前教案的完整内容，作为后续分析与修改依据。";
  }
  if (name === "read_document_metadata" || name === "read_document_outline") {
    return "核对当前教案的基本信息、版本与结构，确保后续处理基于可见文档。";
  }
  if (name.startsWith("propose_") && name !== "propose_classroom_presentation") {
    return "整理并校验本轮修改建议，生成等待教师确认的可见变更。";
  }
  if (name === "create_classroom_presentation" || name === "propose_classroom_presentation" || name === "render_dashi_presentation") {
    return "根据已确认的课堂目标组织演示内容与版式，并生成可查看的结果。";
  }
  if (name === "query_dashi_layouts" || name === "inspect_dashi_layouts") {
    return "读取并核对适合当前课堂内容的演示版式。";
  }
  if (name === "curriculum_analysis") return "分析当前课程目标、内容范围与学习要求。";
  if (name === "learning_design") return "梳理可执行的学习活动与课堂流程。";
  if (name === "assessment") return "核对教学目标、课堂活动与评价任务之间的一致性。";
  if (name === "critic") return "检查当前教案的结构、证据与课堂可执行性。";
  if (/curriculum|textbook|learning_path|knowledge_points|standards/.test(name)) {
    return "读取与当前教材范围匹配的目录、知识点或课标信息。";
  }
  if (/semester|framework|class_feedback/.test(name)) {
    return "读取学期框架与相关课堂信息，核对课时安排和学习连续性。";
  }
  if (/source|knowledge|passage|search_web|open_web/.test(name)) {
    return "读取与当前任务相关的资料，作为后续分析依据。";
  }
  return "使用已授权的备课能力处理当前任务。";
}

/**
 * Completion copy for the teacher-visible chip.
 *
 * Pi's own contract is `label` plus optional structured `details` — it does
 * not prescribe a post-tool narration. Claude / Cursor / Beautiful UI ToolChips
 * likewise keep the factual start description and let the status badge speak.
 * Do not invent “the agent will continue” sentences or name the runtime.
 */
export function safeToolCompletionDetail(
  name: string,
  label: string,
  isError = false,
  startedDetail?: string,
): string {
  if (isError) {
    if (name.startsWith("propose_")) {
      return "修改建议未通过预检，可在本轮根据问题继续调整。";
    }
    return `${label}未完成。`;
  }
  if (name.startsWith("propose_")) {
    return "修改建议已通过预检，并生成了等待教师确认的可见变更。";
  }
  return startedDetail ?? safeToolDetail(name);
}

/** Older journals stored agent-loop narration; treat those as missing copy. */
export function isAgentLoopNarration(detail?: string) {
  return Boolean(detail && /(?:返回给 Pi|返回 Pi|Pi 将)/.test(detail));
}
