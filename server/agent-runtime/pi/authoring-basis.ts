import type { KnowledgeResult, LessonAgentContext, LessonPlan, LessonField, SourceRef } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import type { QueryEmbedder } from "../../providers/query-embedding.js";
import { searchScopedCurriculumStandards } from "../../curriculum/standard-search.js";
import { readLessonTeachingContext } from "../../lesson-teaching-context.js";
import { sourceRefSchema, lessonAlignmentSchema } from "../../domain.js";
import { createLessonMarkdownParser, getLessonHighlightSpans, lessonSelectionPlainText, normalizeLessonSelectionText } from "../../../src/features/lesson-files/lesson-selection-text.js";
import type { z } from "zod";

export type LessonAuthoringBasis = Awaited<ReturnType<typeof loadLessonAuthoringBasis>>;

/** Long source collections stay readable through existing scoped tools. */
export function authoringBasisForPrompt(basis: LessonAuthoringBasis) {
  const bounded = <T>(value: T, tool: string) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 24 * 1024
    ? { data: value, truncated: false }
    : { data: null, truncated: true, instruction: `资料超过预载预算，调用 ${tool} 按需读取；不能将未预载视为资料不存在。` };
  return { ...basis, teaching: bounded(basis.teaching, "read_lesson_design_basis"), curriculum: bounded(basis.curriculum, "read_curriculum_knowledge_points") };
}

/** Read current scoped sources in parallel before authoring, without a model round. */
export async function loadLessonAuthoringBasis(repository: LessonRepository, context: LessonAgentContext, document: LessonPlan, embed?: QueryEmbedder) {
  const profile = context.contextProfile;
  const textbookId = profile?.textbookId;
  const nodeId = profile?.lessonNodeId ?? profile?.unitNodeId;
  const query = [document.topic, document.knowledgePoints, document.objectives].map(lessonSelectionPlainText).filter(Boolean).join(" ").slice(0, 300);
  const [standards, teaching, knowledge] = await Promise.allSettled([
    searchScopedCurriculumStandards({ repository, scope: { userId: context.userId, notebookId: context.notebookId, runId: context.runId },
      query: query || "课程目标 学业质量", limit: 4,
      embed: embed ? value => embed(value, context.abortSignal) : undefined }),
    readLessonTeachingContext(repository, { ownerId: context.userId, notebookId: context.notebookId, lessonFileId: context.lessonFileId }),
    textbookId && nodeId ? repository.readCurriculumNodeKnowledgePoints({ textbookId, nodeId }) : Promise.resolve(null),
  ]);
  context.abortSignal.throwIfAborted();
  const sources: KnowledgeResult[] = standards.status === "fulfilled" ? standards.value.results : [];
  const teachingContext = teaching.status === "fulfilled" ? teaching.value : null;
  const curriculum = knowledge.status === "fulfilled" && knowledge.value?.release ? knowledge.value : null;
  if (curriculum?.points.length) {
    const sources = curriculum.points.flatMap(item => item.point.sources);
    await repository.recordRunEvidence(context.userId, context.runId, "curriculum_knowledge", [...new Map(sources.map(source => [source.id, source])).values()]);
  }
  const gaps: string[] = [];
  if (!sources.length) gaps.push(standards.status === "rejected" ? "课标检索暂不可用" : "未检索到适用课标片段");
  if (!curriculum?.points.length) gaps.push(textbookId && nodeId
    ? knowledge.status === "rejected" ? "绑定章节知识点读取暂不可用" : "绑定章节暂无可用知识点资料"
    : "未绑定教材章节，教材内容待核对");
  if (!teachingContext || teachingContext.planning.status !== "available") gaps.push("未取得可用的上游单元与课时蓝图");
  else if (teachingContext.planning.stale) gaps.push("上游规划已更新，需核对教师原有取舍");
  const feedback = teachingContext?.classroomFeedback;
  if (!feedback?.currentLesson.records.length && !feedback?.learningReviews.records.length
    && !feedback?.previousLessons.some(item => item.records.length || item.learningReviews.records.length)) {
    gaps.push("暂无已记录课堂反馈，学情仅能作为待核对假设");
  }
  return {
    designBasisVersion: teachingContext?.basis.version ?? context.designBasisVersion,
    standardsRelease: standards.status === "fulfilled" ? standards.value.releaseFingerprint : null,
    standards: { status: sources.length ? "available" : "missing", sources, freshness: standards.status === "fulfilled" ? standards.value.freshness : "unavailable" },
    teaching: teachingContext,
    curriculum,
    gaps,
  };
}

export const lessonAuthoringInstruction = [
  "本轮完整教案的课标、规划、知识点与反馈已由服务端读取并绑定。优先使用这些当前来源，不重复读取；资料缺失时只能交付待核对设计草稿，不声称已经对齐课标或取得课堂成效。",
  "完整编写要实际填写 objectives、process、assessment 三栏，评价不能只写在教学过程中。",
  "为每个关键学习目标提交 alignment：objective、process、assessment 分别逐字摘取最终 objectives、process、assessment 栏中的短而完整的关键片段，用来核对目标—任务—达成证据；不能以教学概述代替原文，不能新增正文中不存在的目标。",
  "它们同时作为阅读重点锚点，由服务端保留或补入标记，无需另写标注清单。按可见原文摘取，优先选择说明条件、操作或判据的短语；已有 Markdown 标记与排版换行由服务端处理。",
  "有适用课标时，每条 alignment 提交 standard.sourceId 与逐字 quote；只选择真正支持该目标的条款，不为填表牵强关联。",
  "若返回资料不适用，先用课标工具检索更准确的来源；无法取得可靠依据时用 standardGap 说明具体不适用之处，此类目标只作为待核对设计，不得声称已对齐课标。",
  "提交前核对学科事实、例题推导和答案：算式须逐步验算，正反例与判断标签须一致；课标引文可追溯不代表具体算例或教学关联已被证明正确。",
].join("");

const normalizeAnchor = (value: string) => normalizeLessonSelectionText(value.normalize("NFKC").replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));

function anchorRange(source: string, anchor: string) {
  const positions: number[] = [];
  let visible = "";
  for (let index = 0; index < source.length;) {
    const marker = /^==(?:\{(?:yellow|pink|green|blue|red)\})?/.exec(source.slice(index));
    if (marker) { index += marker[0].length; continue; }
    // Match Markdown's visible escaped punctuation while retaining raw offsets.
    if (source[index] === "\\" && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(source[index + 1] ?? "")) { index += 1; continue; }
    const part = normalizeAnchor(source[index]);
    visible += part;
    for (let offset = 0; offset < part.length; offset += 1) positions.push(index);
    index += 1;
  }
  const normalized = normalizeAnchor(lessonSelectionPlainText(anchor));
  if (!normalized) return null;
  const start = visible.indexOf(normalized);
  if (start < 0 || visible.indexOf(normalized, start + 1) >= 0) return null;
  return { start: positions[start], end: positions[start + normalized.length - 1] + 1 };
}

function objectiveStatements(source: string) {
  const tokens = createLessonMarkdownParser().lexer(source);
  const items = tokens.flatMap(token => token.type === "list" ? token.items.map((item: { text: string }) => item.text) : []);
  // Numbered/bulleted goals are the author's explicit learning units. Section
  // headings and a note after that list are not additional learning goals.
  const statements = items.length ? items : tokens.flatMap(token => token.type === "paragraph" ? [token.raw] : []);
  return statements.map(lessonSelectionPlainText).map(text => text.trim()).filter(Boolean);
}

/** Traceability check, not a claim of independently proven educational quality. */
export function groundLessonAuthoring(document: LessonPlan, alignments: z.infer<typeof lessonAlignmentSchema>[] | undefined, basis: LessonAuthoringBasis) {
  if (!alignments?.length) throw new Error("lesson_alignment_required:请提交关键目标对应的 objective、process、assessment 原文锚点，以及可用课标的 sourceId 和 quote。可用 baseToolCallId 局部补交，不重发正文。");
  const objectives = objectiveStatements(document.objectives);
  const unmapped = objectives.filter(objective => !alignments.some(alignment => normalizeAnchor(objective).includes(normalizeAnchor(lessonSelectionPlainText(alignment.objective)))));
  const errors: string[] = [];
  if (unmapped.length) errors.push(`lesson_objective_unmapped:以下目标仍需对应任务与评价，锚点须摘录原文：${JSON.stringify(unmapped)}`);
  const fields = { objective: "objectives", process: "process", assessment: "assessment" } as const;
  const next = { ...document };
  const citations: SourceRef[] = [];
  for (const [alignmentIndex, alignment] of alignments.entries()) {
    if (basis.standards.sources.length && !alignment.standard && !alignment.standardGap) errors.push(`lesson_standard_alignment_required:alignments[${alignmentIndex}] 缺课标来源与逐字引文；候选不支持该目标时用 standardGap 说明具体不适用之处，不得牵强引用。`);
    if (alignment.standard && alignment.standardGap) errors.push(`lesson_standard_alignment_invalid:alignments[${alignmentIndex}] 不能同时声称已有课标对应和缺少课标依据。`);
    if (alignment.standard) {
      const source = basis.standards.sources.find(item => item.id === alignment.standard!.sourceId);
      if (!source || !source.passage.includes(alignment.standard.quote)) errors.push(`lesson_standard_quote_invalid:alignments[${alignmentIndex}].standard 须逐字引用本轮绑定课标片段，不能编造或引用其他资料。`);
      else citations.push(sourceRefSchema.parse(source));
    }
    for (const [key, field] of Object.entries(fields) as Array<[keyof typeof fields, LessonField]>) {
      const anchor = alignment[key];
      // Keep teacher-authored tones and existing nested emphasis intact.
      const range = anchorRange(next[field], anchor);
      if (!range) {
        errors.push(`lesson_alignment_anchor_invalid:alignments[${alignmentIndex}].${key} 的“${anchor}”未唯一匹配 ${field} 正文。请从 candidateText.${field} 直接摘录；没有该目标时删除多余映射，不发明目标。`);
        continue;
      }
      const spans = getLessonHighlightSpans(next[field]);
      const existingMarks = [...next[field].matchAll(/==(?:\{(?:yellow|pink|green|blue|red)\})?(?:(?!==)[^\n])+==/g)];
      if (existingMarks.some(mark => mark.index < range.end && mark.index + mark[0].length > range.start
        && spans.some(span => getLessonHighlightSpans(mark[0]).some(item => item.text === span.text && item.tone === span.tone)))) continue;
      const text = next[field].slice(range.start, range.end);
      const lines = text.split("\n");
      const emphasized = lines.map(line => line.trim() ? `==${line}==` : line).join("\n");
      const marked = next[field].slice(0, range.start) + emphasized + next[field].slice(range.end);
      if (getLessonHighlightSpans(marked).length !== spans.length + lines.filter(line => line.trim()).length
        || normalizeAnchor(lessonSelectionPlainText(marked)) !== normalizeAnchor(lessonSelectionPlainText(next[field]))) errors.push(`lesson_alignment_anchor_invalid:alignments[${alignmentIndex}].${key} 不能处于代码、转义或不可渲染的标记内。`);
      else next[field] = marked;
    }
  }
  // Report all problems together so a repair does not discover one bad anchor
  // per model round. No proposal is captured until the entire draft passes.
  if (errors.length) throw new Error(errors.join("\n"));
  return { document: next, citations: [...new Map(citations.map(source => [source.id, source])).values()] };
}

export function authoringGaps(basis: LessonAuthoringBasis, alignments: z.infer<typeof lessonAlignmentSchema>[]) {
  return [...new Set([...basis.gaps, ...alignments.flatMap(alignment => alignment.standardGap ? [`课标关联待核对：${alignment.standardGap}`] : [])])].slice(0, 12);
}

export async function assertAuthoringBasisCurrent(repository: LessonRepository, context: LessonAgentContext, basis: LessonAuthoringBasis) {
  const [current, release] = await Promise.all([
    repository.getLessonDesignBasis(context.userId, context.lessonFileId),
    basis.standards.freshness === "unavailable" ? Promise.resolve(null) : repository.getPublishedCurriculumStandardFingerprint(),
  ]);
  if (current?.basis.version !== basis.designBasisVersion) throw new Error("design_basis_context_stale");
  if (basis.standards.freshness !== "unavailable" && release !== basis.standardsRelease) throw new Error("resource_context_stale");
}
