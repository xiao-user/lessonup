import { describe, expect, it, vi } from "vitest";
import type { LessonAgentContext, LessonPlan } from "../../domain.js";
import { documentPatchSchema } from "../../domain.js";
import { MemoryLessonRepository } from "../../repositories/memory-repository.js";
import { createPiDocumentProposalTool } from "./proposal-tools.js";
import { assertAuthoringBasisCurrent, authoringBasisForPrompt, groundLessonAuthoring, loadLessonAuthoringBasis } from "./authoring-basis.js";
import { deriveReadingEmphasis } from "./reading-emphasis.js";
import { getLessonHighlightSpans, lessonSelectionPlainText } from "../../../src/features/lesson-files/lesson-selection-text.js";

const document: LessonPlan = { unit: "第一单元", period: "1", totalPeriods: "1", topic: "等式的性质",
  objectives: "说明等式两边同加同一个数仍相等。", knowledgePoints: "等式；两边同加。", continuity: "承接等号含义。",
  focus: "说明理由。", preparation: "等式卡。", process: "独立比较两边同加与只改一边，写出判断理由。",
  assessment: "出口条：判断新等式，解释两边同加相同数；只报答案不算说明理由。", homework: "编一个例子。", board: "两边同加", reflection: "待收集。" };
const alignment = { objective: "同加同一个数仍相等", process: "比较两边同加与只改一边", assessment: "只报答案不算说明理由" };

async function fixture() {
  const repository = new MemoryLessonRepository();
  await repository.importNotebookGraph("teacher", [{ id: "book", title: "数学", subject: "数学", className: "合成班级", year: "2026",
    files: [{ id: "lesson", title: document.topic, pages: 1, lessonPlan: document }] }]);
  for (const id of ["run", "next-run"]) await repository.createRun({ id, ownerId: "teacher", threadId: "thread", branchId: "branch", model: "test", status: "completed", startedAt: new Date().toISOString(), skillVersions: {}, attachmentSourceIds: [], agentDefinitionVersion: "test", capabilityPlan: { skillIds: [], toolGroups: [], mcpServers: [], evidenceRequired: false } });
  const context: LessonAgentContext = { resourceType: "lesson_file", userId: "teacher", notebookId: "book", lessonFileId: "lesson",
    threadId: "thread", branchId: "branch", runId: "run", activeSectionId: "process", documentVersion: 0, designBasisVersion: 0,
    contextProfile: {}, allowedKnowledgeScopes: ["public", "user:teacher"], attachmentSourceIds: [], abortSignal: new AbortController().signal };
  return { repository, context };
}

describe("complete lesson authoring basis", () => {
  it("reuses standards within the published version, but re-reads after a release change", async () => {
    const { repository, context } = await fixture();
    const retrieve = vi.spyOn(repository, "searchCurriculumStandards").mockResolvedValue([{ id: "standard", title: "合成课标", kind: "public", passage: "能解释等式性质并说明理由。", score: 1 }]);
    const first = await loadLessonAuthoringBasis(repository, context, document);
    const second = await loadLessonAuthoringBasis(repository, { ...context, runId: "next-run" }, document);
    expect(first.standards.freshness).toBe("retrieved");
    expect(second.standards.freshness).toBe("reused");
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect((await repository.listRunEvidence("teacher", "next-run"))[0].source.id).toBe("standard");
    repository.getPublishedCurriculumStandardFingerprint = async () => "new-release";
    await loadLessonAuthoringBasis(repository, context, document);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it("records missing sources and retrieval failures without inventing classroom data", async () => {
    const { repository, context } = await fixture();
    const empty = await loadLessonAuthoringBasis(repository, context, document);
    expect(empty.gaps).toEqual(expect.arrayContaining(["未检索到适用课标片段", "暂无已记录课堂反馈，学情仅能作为待核对假设"]));
    repository.searchCurriculumStandards = async () => { throw new Error("private_provider_error"); };
    const failed = await loadLessonAuthoringBasis(repository, context, { ...document, topic: "另一个课题" });
    expect(failed.gaps).toContain("课标检索暂不可用");
    expect(JSON.stringify(failed)).not.toContain("private_provider_error");
    await expect(loadLessonAuthoringBasis(repository, { ...context, userId: "another-owner" }, document)).resolves.toMatchObject({ standards: { sources: [] }, teaching: null });
    repository.getPublishedCurriculumStandardFingerprint = async () => { throw new Error("private_storage_error"); };
    const offline = await loadLessonAuthoringBasis(repository, context, document);
    await expect(assertAuthoringBasisCurrent(repository, context, offline)).resolves.toBeUndefined();
    expect(offline.gaps).toContain("课标检索暂不可用");
  });

  it("marks content-selected anchors, preserves teacher tones and does not change the underlying text", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    const original = { ...document, objectives: document.objectives.replace(alignment.objective, `=={pink}${alignment.objective}==`) };
    const grounded = groundLessonAuthoring(original, [alignment], basis).document;
    expect(grounded.objectives).toBe(original.objectives);
    expect(grounded.process).toContain(`==${alignment.process}==`);
    expect(grounded.assessment).toContain(`==${alignment.assessment}==`);
    for (const field of ["objectives", "process", "assessment"] as const) {
      expect(grounded[field].replace(/==(?:\{pink\})?/g, "")).toBe(document[field]);
    }
    expect(grounded.homework).toBe(document.homework);
  });

  it("rejects untraceable standards, missing objective coverage and code-block anchors", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    expect(() => groundLessonAuthoring(document, undefined, basis)).toThrow("lesson_alignment_required");
    expect(() => groundLessonAuthoring({ ...document, objectives: "1. " + document.objectives + "\n2. 判断只改一边。" }, [alignment], basis)).toThrow("lesson_objective_unmapped");
    expect(() => groundLessonAuthoring({ ...document, process: "`" + alignment.process + "`" }, [alignment], basis)).toThrow("lesson_alignment_anchor_invalid");
    basis.standards.sources.push({ id: "standard", title: "课标片段", kind: "public", passage: "理解等式的性质，能解释变形理由。", score: 1 });
    expect(() => groundLessonAuthoring(document, [alignment], basis)).toThrow("lesson_standard_alignment_required");
    expect(() => groundLessonAuthoring(document, [{ ...alignment, standard: { sourceId: "standard", quote: "不存在的课标内容" } }], basis)).toThrow("lesson_standard_quote_invalid");
    expect(groundLessonAuthoring(document, [{ ...alignment, standard: { sourceId: "standard", quote: "能解释变形理由" } }], basis).citations[0].id).toBe("standard");
  });

  it("tolerates renderer whitespace around existing marks without treating a paraphrase as a quote", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    const source = { ...document, objectives: "能辨认 ==只改一边的错误== 并说明理由。" };
    const aligned = { ...alignment, objective: "能辨认只改一边的错误并说明理由" };
    expect(groundLessonAuthoring(source, [aligned], basis).document.objectives).toBe(source.objectives);
    expect(() => groundLessonAuthoring(source, [{ ...aligned, objective: "理解错误原因" }], basis)).toThrow("lesson_objective_unmapped");
    const quoted = { ...document, objectives: '能用"天平平衡"解释两边同加。' };
    const grounded = groundLessonAuthoring(quoted, [{ ...alignment, objective: "能用“天平平衡”解释两边同加" }], basis).document;
    expect(lessonSelectionPlainText(grounded.objectives)).toBe(lessonSelectionPlainText(quoted.objectives));
    expect(getLessonHighlightSpans(grounded.objectives)).toEqual([{ text: '能用"天平平衡"解释两边同加', tone: "yellow" }]);
  });

  it("traces equation anchors and escaped punctuation while preserving plain text", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    const source = { ...document, process: '先判断 (3+2)+1=5+1，再解释 \\"同加同数\\" 的条件。' };
    for (const process of ["(3+2)+1=5+1", '解释 "同加同数" 的条件']) {
      const next = groundLessonAuthoring(source, [{ ...alignment, process }], basis).document;
      expect(lessonSelectionPlainText(next.process)).toBe(lessonSelectionPlainText(source.process));
      expect(getLessonHighlightSpans(next.process)).toEqual([{ text: process, tone: "yellow" }]);
    }
  });

  it("does not confuse headings or a post-list caveat with another learning objective", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    const source = { ...document, objectives: "## 学习目标\n\n1. " + document.objectives + "\n\n（学情未知，以上为待核对设计目标。）" };
    expect(groundLessonAuthoring(source, [alignment], basis).document.objectives).toContain(`==${alignment.objective}==`);
  });

  it("accepts copied markers and line breaks without another model repair", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    for (const process of ["期望学生说出=={pink}两边变化相同，所以仍然相等==", '每人独立完成：\n新题：7-2=5，判断"(7-2)+3=5"并说明理由。']) {
      const source = { ...document, process };
      const next = groundLessonAuthoring(source, [{ ...alignment, process }], basis).document;
      expect(lessonSelectionPlainText(next.process)).toBe(lessonSelectionPlainText(source.process));
      expect(getLessonHighlightSpans(next.process).length).toBeGreaterThan(0);
      if (process.includes("{pink}")) expect(next.process).toBe(source.process);
    }
  });

  it("reports all bad anchors together and marks repeated ideas at their actual location", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    let message = "";
    try { groundLessonAuthoring(document, [{ objective: "虚构目标", process: "虚构任务", assessment: "虚构评价" }], basis); }
    catch (error) { message = (error as Error).message; }
    for (const key of ["objective", "process", "assessment"]) expect(message).toContain(`alignments[0].${key}`);
    const source = { ...document, process: "先识别=={pink}错误==。学生独立解释错误成因。" };
    expect(groundLessonAuthoring(source, [{ ...alignment, process: "独立解释错误成因" }], basis).document.process)
      .toBe("先识别=={pink}错误==。学生==独立解释错误成因==。");
  });

  it("revalidates missing-source snapshots too and keeps explicit source requirements mandatory", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    const readRelease = repository.getPublishedCurriculumStandardFingerprint.bind(repository);
    repository.getPublishedCurriculumStandardFingerprint = async () => "new-release";
    await expect(assertAuthoringBasisCurrent(repository, context, basis)).rejects.toThrow("resource_context_stale");
    repository.getPublishedCurriculumStandardFingerprint = readRelease;
    const runtime = createPiDocumentProposalTool({ repository, context, plan: { fullRewriteRequested: true, writeMode: "explicit", evidenceRequired: true, requiredEvidenceKinds: ["curriculum_standard_search"], toolGroups: [], mcpServers: [], skillIds: [] }, authoringBasis: basis });
    await expect(runtime.tool.execute("required", { summary: "编写教案", operations: [{ field: "process", replacement: document.process }], alignments: [alignment] })).rejects.toThrow("evidence_required");
    expect(runtime.getProposal()).toBeNull();
  });

  it("repairs only alignment data after preflight failure and saves honest gaps in the approval patch", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    const runtime = createPiDocumentProposalTool({ repository, context, plan: { fullRewriteRequested: true, writeMode: "explicit", evidenceRequired: false, toolGroups: [], mcpServers: [], skillIds: [] }, authoringBasis: basis });
    await expect(runtime.tool.execute("initial", { summary: "编写教案", operations: [{ field: "process", replacement: document.process }] })).rejects.toThrow("lesson_authoring_needs_revision");
    expect(runtime.getProposal()).toBeNull();
    await runtime.tool.execute("repair", { summary: "补齐学习链", baseToolCallId: "initial", alignments: [alignment] });
    const patch = runtime.getProposal()!.patch;
    expect(patch).toMatchObject({ authoringBasis: { gaps: basis.gaps, alignments: [alignment] }, summary: expect.stringContaining("依据待核对") });
    if (!("operations" in patch)) throw new Error("expected_document_patch");
    expect(deriveReadingEmphasis(documentPatchSchema.parse(patch).operations).fields).toEqual(expect.arrayContaining(["objectives", "process", "assessment"]));
    expect((await repository.getLessonFile("teacher", "lesson"))?.document).toEqual(document);
    const oversized = { ...basis, curriculum: { points: [{ point: { description: "x".repeat(30_000) } }] } } as unknown as typeof basis;
    expect(authoringBasisForPrompt(oversized).curriculum).toMatchObject({ data: null, truncated: true });
  });

  it("retains a valid draft when a mapping property is missing", async () => {
    const { repository, context } = await fixture();
    const basis = await loadLessonAuthoringBasis(repository, context, document);
    const runtime = createPiDocumentProposalTool({ repository, context, plan: { fullRewriteRequested: true, writeMode: "explicit", evidenceRequired: false, toolGroups: [], mcpServers: [], skillIds: [] }, authoringBasis: basis });
    await expect(runtime.tool.execute("incomplete-map", { summary: "编写教案", operations: [{ field: "process", replacement: document.process }], alignments: [{ objective: alignment.objective, assessment: alignment.assessment }] })).rejects.toThrow("lesson_authoring_needs_revision");
    await runtime.tool.execute("complete-map", { summary: "补齐任务锚点", baseToolCallId: "incomplete-map", alignments: [alignment] });
    expect(runtime.getProposal()?.patch).toMatchObject({ authoringBasis: { alignments: [alignment] } });
    expect((await repository.getLessonFile("teacher", "lesson"))?.documentVersion).toBe(0);
  });
});
