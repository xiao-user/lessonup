import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { lessonPlanSchema } from "../domain.js";
import { LearningService } from "../learning/service.js";
import type { LearningEvidence, LearningEvidenceInput } from "../learning/domain.js";
import type { ObservationPlan } from "../learning/observation-plan.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { createD1LessonCoreRepository } from "../repositories/d1-lesson-core-repository.js";
import { DecisionService } from "./service.js";

const scopeOwner = "teacher";
const times = { baseline: "2026-10-18T08:00:00.000Z", implementation: "2026-10-18T09:00:00.000Z", followup: "2026-10-18T09:30:00.000Z", now: "2026-10-18T10:00:00.000Z" };
const document = lessonPlanSchema.parse({ unit: "第一单元", period: "第2课时", totalPeriods: "2", topic: "春", objectives: "结合相似点解释比喻如何突出春景特点", knowledgePoints: "比喻", continuity: "上一课已识别修辞", focus: "解释效果", preparation: "课文与出口条", process: "独立解释后比较回答", assessment: "出口条：只圈出本体和喻体。", homework: "解释未讨论语句", board: "相似点→特点", reflection: "尚未实施" });
const designPlan: ObservationPlan = {
  kind: "design_check", objective: "检查目标与评价是否对齐", task: "逐条检查当前教案目标与出口条",
  criterion: "出口条要求相似点及其与春景特点的联系", learnerGroup: "当前课时教案", method: "document_check",
  conditions: "只检查当前教案文本，不判断学生学习效果", baselineEvidenceId: null,
};
const learningPlan: ObservationPlan = {
  kind: "learning_change", objective: "解释比喻表达效果", task: "独立解释未讲解语句",
  criterion: "指出相似点并解释其如何突出春景特点", learnerGroup: "七年级一班同一组学生", method: "student_work",
  conditions: "相当文本难度、无句式提示、独立作答5分钟", baselineEvidenceId: null,
};
const refs = [{ field: "assessment", excerpt: document.assessment, claim: "现出口条仅测识别", applicability: "本教案设计对齐检查", limitations: ["不能推断学生学习成效"] }];
const proposal = (plan: ObservationPlan | null = designPlan) => ({
  contextVersion: { documentVersion: 0, frameworkVersion: null }, decisionType: "goal_evidence", question: "出口条是否检验解释目标？",
  options: [{ id: "keep", statement: "保留识别题", tradeoffs: ["评分负担低但无解释产出"] }, { id: "explain", statement: "增加相似点与效果解释", tradeoffs: ["可检查解释产出，增加评分时间"] }],
  chosenOptionId: null, rationale: "当前只检验教案内部对齐", counterevidence: ["过程环节可能另有可记录的解释产出"],
  assumptions: ["当前正式检验由出口条承担"], uncertainties: ["时间容量尚未试行"], confidence: 0.6,
  expectedSignal: "当前出口条明确要求解释", falsifier: "若当前出口条已要求解释，则不需要新增该要求",
  observationPlan: plan, lessonEvidence: refs, createdBy: "teacher", status: "proposed",
});
async function fixture(kind: "memory" | "sqlite") {
  let db: DatabaseSync | undefined;
  let repository: LessonRepository;
  if (kind === "sqlite") {
    db = new DatabaseSync(":memory:");
    const directory = new URL("../../d1/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, directory), "utf8"));
    for (const owner of [scopeOwner, "other"]) db.prepare("INSERT INTO users VALUES (?, ?, 'dummy', 'now', 'now')").run(owner, owner);
    const execute = (statement: SqlStatement) => {
      const prepared = db!.prepare(statement.sql);
      if (prepared.columns().length) {
        const rows = prepared.all(...statement.params ?? []);
        return { rows, rowsAffected: /^\s*(UPDATE|INSERT|DELETE)/i.test(statement.sql) ? rows.length : 0 };
      }
      return { rows: [], rowsAffected: Number(prepared.run(...statement.params ?? []).changes) };
    };
    const sql = { query: async (statement: SqlStatement) => execute(statement), batch: async (statements: SqlStatement[]) => {
      db!.exec("BEGIN"); try { const result = statements.map(execute); db!.exec("COMMIT"); return result; }
      catch (error) { db!.exec("ROLLBACK"); throw error; }
    } } as SqlDatabase;
    repository = createD1LessonCoreRepository(sql, () => times.now);
  } else repository = new MemoryLessonRepository();
  const notebook = await repository.createNotebook(scopeOwner, { title: "验收语文", className: "七年级一班", year: "2026", subject: "语文", tone: "teal" });
  const file = await repository.createLessonFile(scopeOwner, { notebookId: notebook.id, title: "春", type: "教案", document, pageCount: 1 });
  const scope = { ownerId: scopeOwner, lessonFileId: file.id };
  return { repository, notebook, file, scope, db, decisions: new DecisionService(repository, () => times.now), learning: new LearningService(repository, () => times.now) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function observation(plan: ObservationPlan, overrides: Partial<LearningEvidenceInput> = {}): LearningEvidenceInput {
  return { documentVersion: 0, objective: plan.objective, task: plan.task, criterion: plan.criterion, learnerGroup: plan.learnerGroup,
    method: plan.method, conditions: plan.conditions, synthetic: false, observation: plan.kind === "design_check" ? "出口条已要求解释相似点与效果" : "同一判据记录本次独立解释产出，未归因",
    sourceReference: plan.kind === "design_check" ? "当前教案评价栏逐条核对" : "教师本次实际采集的匿名作品汇总", observedAt: times.followup, ...overrides };
}
async function implemented(f: Fixture, plan: ObservationPlan = designPlan) {
  const draft = await f.decisions.propose(f.scope, proposal(plan), randomUUID());
  await f.decisions.act(f.scope, draft.id, { action: "confirm", expectedVersion: 1, chosenOptionId: "explain" }, randomUUID());
  return f.decisions.act(f.scope, draft.id, { action: "implement", expectedVersion: 2, implementedAt: times.implementation }, randomUUID());
}
const reviewInput = (evidenceId: string, outcome: "supported" | "not_supported" | "inconclusive" = "supported") => ({
  action: "review", expectedVersion: 3, outcome, rationale: "按登记的观察计划核对本次证据", limitations: "只支持本次检查；不证明因果教学效果", evidenceIds: [evidenceId],
});

for (const kind of ["memory", "sqlite"] as const) describe(`${kind} decision observation contract`, () => {
  it("allows teacher draft → source-bound revision → confirmation → direct document observation → design review", async () => {
    const f = await fixture(kind);
    try {
      const draft = await f.decisions.propose(f.scope, { ...proposal(null), status: "draft", lessonEvidence: [] }, "draft");
      const revised = await f.decisions.act(f.scope, draft.id, { action: "revise", expectedVersion: 1,
        contextVersion: { documentVersion: 0 }, observationPlan: designPlan, lessonEvidence: refs, status: "proposed" }, "revise");
      const context = await f.decisions.readContext(f.scope, draft.id);
      expect(context.evidenceCards).toHaveLength(1);
      expect(context.evidenceCards[0]).toMatchObject({ kind: "platform_data", excerpt: document.assessment,
        source: { system: "lessonup", uri: `lessonup://lesson-files/${f.file.id}`, locator: "assessment", version: "0", capturedAt: times.now } });
      const confirmed = await f.decisions.act(f.scope, draft.id, { action: "confirm", expectedVersion: revised.version, chosenOptionId: "explain" }, "confirm");
      const active = await f.decisions.act(f.scope, draft.id, { action: "implement", expectedVersion: confirmed.version, implementedAt: times.implementation }, "implement");
      const evidence = await f.learning.recordEvidence(f.scope, observation(designPlan, { decisionId: active.id, decisionVersion: active.version }), "observation");
      const reviewed = await f.decisions.act(f.scope, active.id, { ...reviewInput(evidence.id), expectedVersion: active.version }, "review");
      expect(reviewed).toMatchObject({ status: "reviewed", observationPlan: { kind: "design_check", method: "document_check" }, review: { outcome: "supported" } });
      expect((await f.decisions.readContext(f.scope, active.id)).observations).toEqual([evidence]);
      expect((await f.repository.getLessonFile(scopeOwner, f.file.id))!.document).toEqual(document);
      // This verifies routing, provenance and lifecycle; it does not establish the professional quality of the prose.
    } finally { f.db?.close(); }
  });

  it("rejects a design review when the lesson changes after validation but before commit", async () => {
    const f = await fixture(kind);
    try {
      const active = await implemented(f);
      const evidence = await f.learning.recordEvidence(f.scope, observation(designPlan, {
        decisionId: active.id, decisionVersion: active.version,
      }), "design-observation");
      const save = f.repository.saveDecision.bind(f.repository);
      vi.spyOn(f.repository, "saveDecision").mockImplementationOnce(async (...args) => {
        await f.repository.saveLessonDocument({ ownerId: scopeOwner, fileId: f.file.id, baseVersion: 0,
          document: { ...document, assessment: "提交前被另一请求更新的评价" }, pageCount: 1, source: "manual", idempotencyKey: "concurrent-edit" });
        return save(...args);
      });
      await expect(f.decisions.act(f.scope, active.id, reviewInput(evidence.id), "racing-review"))
        .rejects.toThrow(/stale_(document|decision)/);
      expect((await f.repository.getDecision(scopeOwner, active.id))?.status).toBe("implemented");
      expect(await f.repository.getDecisionCommandResult(scopeOwner, "racing-review")).toBeNull();
      expect(await f.repository.listDecisionVersions(scopeOwner, active.id)).toHaveLength(3);
    } finally { f.db?.close(); }
  });

  it("preserves canonical synthetic provenance even when a card quotes an unmarked sentence", async () => {
    const f = await fixture(kind);
    try {
      const evidence = await f.learning.recordEvidence(f.scope, observation(learningPlan, {
        synthetic: true, observation: "学生能够解释相似点。合成验收数据。",
      }), "synthetic-source");
      const card = { kind: "student_work", level: "primary", source: {
        system: "lessonup", uri: `lessonup://learning-evidence/${evidence.id}`, locator: "observation", version: "0", capturedAt: times.now,
      }, excerpt: "学生能够解释相似点。", claim: "记录了独立解释", applicability: "本次观察", limitations: ["仅支持局部判断"] };
      await expect(f.decisions.propose(f.scope, { ...proposal(), evidenceCards: [card] }, "laundered-source"))
        .rejects.toThrow("decision_synthetic_evidence_declared_real");
      const saved = await f.decisions.propose(f.scope, { ...proposal(), evidenceCards: [{ ...card, level: "synthetic" }] }, "labelled-source");
      expect((await f.decisions.readContext(f.scope, saved.id)).evidenceCards.some((item) => item.level === "synthetic")).toBe(true);
      await expect(f.decisions.propose(f.scope, { ...proposal(), evidenceCards: [{ ...card, level: "synthetic", excerpt: "未曾记录的学生表现" }] }, "invented-quote"))
        .rejects.toThrow("decision_evidence_excerpt_not_exact");
      await expect(f.decisions.propose({ ...f.scope, ownerId: "other" }, { ...proposal(), evidenceCards: [card] }, "foreign-source"))
        .rejects.toThrow();
    } finally { f.db?.close(); }
  });

  it("requires a plan at confirmation and rejects fabricated or stale lesson excerpts", async () => {
    const f = await fixture(kind);
    try {
      const draft = await f.decisions.propose(f.scope, proposal(null), "no-plan");
      await expect(f.decisions.act(f.scope, draft.id, { action: "confirm", expectedVersion: 1, chosenOptionId: "explain" }, "confirm")).rejects.toThrow("decision_observation_plan_required");
      await expect(f.decisions.act(f.scope, draft.id, { action: "revise", expectedVersion: 1, contextVersion: { documentVersion: 0 },
        lessonEvidence: [{ ...refs[0], excerpt: "原文不存在的解释判据" }] }, "fake")).rejects.toThrow("decision_lesson_excerpt_stale");
      await f.repository.saveLessonDocument({ ownerId: scopeOwner, fileId: f.file.id, baseVersion: 0, document: { ...document, assessment: "新的出口条" }, pageCount: 1, source: "manual", idempotencyKey: "changed-document" });
      await expect(f.decisions.act(f.scope, draft.id, { action: "revise", expectedVersion: 1, contextVersion: { documentVersion: 0 } }, "stale")).rejects.toThrow("stale_document");
      await expect(f.decisions.act(f.scope, draft.id, { action: "revise", expectedVersion: 1, contextVersion: { documentVersion: 1 }, lessonEvidence: refs }, "old-quote")).rejects.toThrow("decision_lesson_excerpt_stale");
      expect((await f.decisions.readContext(f.scope, draft.id)).versions).toHaveLength(1);
    } finally { f.db?.close(); }
  });

  it("replays lost-response proposal/action/observation payloads after later versions and document changes", async () => {
    const f = await fixture(kind);
    try {
      const input = proposal();
      const draft = await f.decisions.propose(f.scope, input, "lost-proposal");
      const confirmation = { action: "confirm", expectedVersion: 1, chosenOptionId: "explain" };
      const confirmed = await f.decisions.act(f.scope, draft.id, confirmation, "lost-confirmation");
      const active = await f.decisions.act(f.scope, draft.id, { action: "implement", expectedVersion: 2, implementedAt: times.implementation }, "implement");
      const observedInput = observation(designPlan, { decisionId: active.id, decisionVersion: active.version });
      const evidence = await f.learning.recordEvidence(f.scope, observedInput, "lost-observation");
      await f.decisions.act(f.scope, active.id, reviewInput(evidence.id), "review");
      await f.repository.saveLessonDocument({ ownerId: scopeOwner, fileId: f.file.id, baseVersion: 0, document: { ...document, assessment: "已变更" }, pageCount: 1, source: "manual", idempotencyKey: "changed-document" });
      expect(await f.decisions.propose(f.scope, input, "lost-proposal")).toEqual(draft);
      expect(await f.decisions.act(f.scope, draft.id, confirmation, "lost-confirmation")).toEqual(confirmed);
      expect(await f.learning.recordEvidence(f.scope, observedInput, "lost-observation")).toEqual(evidence);
      await expect(f.decisions.propose(f.scope, { ...input, question: "不同问题" }, "lost-proposal")).rejects.toThrow("idempotency_conflict");
      await expect(f.decisions.act(f.scope, draft.id, { ...confirmation, chosenOptionId: "keep" }, "lost-confirmation")).rejects.toThrow("idempotency_conflict");
      await expect(f.learning.recordEvidence(f.scope, { ...observedInput, observation: "不同观察" }, "lost-observation")).rejects.toThrow("idempotency_conflict");
      expect(await f.repository.listDecisionVersions(scopeOwner, draft.id)).toHaveLength(4);
      expect(await f.repository.listLearningEvidence(scopeOwner, f.file.id, 20)).toHaveLength(1);
    } finally { f.db?.close(); }
  });

  it("hides unfinished and cancelled native proposals and prevents teacher adoption until delivery", async () => {
    const f = await fixture(kind);
    try {
      const { thread, branch } = await f.repository.createThread(scopeOwner, { notebookId: f.notebook.id, lessonFileId: f.file.id });
      const runId = randomUUID();
      await f.repository.createRun({ id: runId, ownerId: scopeOwner, threadId: thread.id, branchId: branch.id, model: "test", status: "running", startedAt: times.now });
      const input = { ...proposal(), createdBy: "agent", lessonEvidence: [], evidenceCards: [{ kind: "platform_data", level: "primary",
        source: { system: "lessonup", uri: `lessonup://lesson-files/${f.file.id}`, locator: "assessment", version: "0", capturedAt: times.now },
        excerpt: document.assessment, claim: "设计观察", applicability: "当前教案", limitations: ["不证明学生成效"] }] };
      const candidate = await f.decisions.propose(f.scope, input, "agent", { runId, threadId: thread.id, branchId: branch.id });
      for (const status of ["running", "cancelled"] as const) {
        await f.repository.updateRun(scopeOwner, runId, { status });
        expect((await f.decisions.read(f.scope)).decisions).toEqual([]);
        expect((await f.decisions.read(f.scope)).evidenceCards).toEqual([]);
        await expect(f.decisions.readContext(f.scope, candidate.id)).rejects.toThrow("decision_proposal_not_delivered");
        await expect(f.decisions.act(f.scope, candidate.id, { action: "confirm", expectedVersion: 1, chosenOptionId: "explain" }, `adopt-${status}`)).rejects.toThrow("decision_proposal_not_delivered");
      }
      await f.repository.updateRun(scopeOwner, runId, { status: "completed" });
      expect((await f.decisions.read(f.scope)).decisions.map(item => item.id)).toEqual([candidate.id]);
    } finally { f.db?.close(); }
  });

  it("accepts learning-change supported only with an explicit real comparable baseline and linked later observation", async () => {
    const f = await fixture(kind);
    try {
      const baseline = await f.learning.recordEvidence(f.scope, observation(learningPlan, { observedAt: times.baseline }), "baseline");
      const active = await implemented(f, { ...learningPlan, baselineEvidenceId: baseline.id });
      const evidence = await f.learning.recordEvidence(f.scope, observation(learningPlan, { decisionId: active.id, decisionVersion: active.version }), "later");
      const reviewed = await f.decisions.act(f.scope, active.id, reviewInput(evidence.id), "review");
      expect(reviewed.review).toMatchObject({ outcome: "supported", evidenceIds: [evidence.id] });
      expect(reviewed.observationPlan?.baselineEvidenceId).toBe(baseline.id);
    } finally { f.db?.close(); }
  });

  const incomparable = [
    ["different objective", { objective: "只识别修辞" }], ["different criterion", { criterion: "只圈出本体" }],
    ["different conditions", { conditions: "教师给出句式提示" }], ["missing conditions", { conditions: undefined }],
    ["different group", { learnerGroup: "另一个班" }], ["different method", { method: "assessment" }],
    ["synthetic followup", { synthetic: true }], ["undeclared nature", { synthetic: undefined }],
    ["unlinked observation", { decisionId: undefined, decisionVersion: undefined }],
  ] as const;
  it.each(incomparable)("rejects both conclusive outcomes for %s, while retaining inconclusive review", async (_name, changed) => {
    const f = await fixture(kind);
    try {
      const baseline = await f.learning.recordEvidence(f.scope, observation(learningPlan, { observedAt: times.baseline }), "baseline");
      const active = await implemented(f, { ...learningPlan, baselineEvidenceId: baseline.id });
      // Direct repository insertion also covers legacy records with undeclared nature, which the input schema now refuses when linked.
      const evidence: LearningEvidence = { ...observation(learningPlan, { decisionId: active.id, decisionVersion: active.version }), ...changed,
        id: randomUUID(), ownerId: scopeOwner, notebookId: f.notebook.id, lessonFileId: f.file.id, createdAt: times.now };
      await f.repository.saveLearningEvidence(evidence, { idempotencyKey: "legacy", fingerprint: "legacy", documentVersion: 0, decisionVersion: active.version });
      for (const outcome of ["supported", "not_supported"] as const) await expect(f.decisions.act(f.scope, active.id, reviewInput(evidence.id, outcome), outcome)).rejects.toThrow();
      expect((await f.decisions.act(f.scope, active.id, reviewInput(evidence.id, "inconclusive"), "uncertain")).review?.outcome).toBe("inconclusive");
    } finally { f.db?.close(); }
  });

  it.each([true, undefined])("does not turn baseline nature %s into learning-change support", async synthetic => {
    const f = await fixture(kind);
    try {
      const baseline = await f.learning.recordEvidence(f.scope, observation(learningPlan, { observedAt: times.baseline, synthetic }), "baseline");
      const active = await implemented(f, { ...learningPlan, baselineEvidenceId: baseline.id });
      const evidence = await f.learning.recordEvidence(f.scope, observation(learningPlan, { decisionId: active.id, decisionVersion: active.version }), "later");
      for (const outcome of ["supported", "not_supported"] as const) await expect(f.decisions.act(f.scope, active.id, reviewInput(evidence.id, outcome), outcome)).rejects.toThrow();
      expect((await f.decisions.act(f.scope, active.id, reviewInput(evidence.id, "inconclusive"), "uncertain")).status).toBe("reviewed");
    } finally { f.db?.close(); }
  });

  it("requires a baseline for conclusive learning claims but permits recording the evidence gap", async () => {
    const f = await fixture(kind);
    try {
      const active = await implemented(f, learningPlan);
      const evidence = await f.learning.recordEvidence(f.scope, observation(learningPlan, { decisionId: active.id, decisionVersion: active.version }), "later");
      for (const outcome of ["supported", "not_supported"] as const) await expect(f.decisions.act(f.scope, active.id, reviewInput(evidence.id, outcome), outcome)).rejects.toThrow("decision_review_baseline_required");
      expect((await f.decisions.act(f.scope, active.id, reviewInput(evidence.id, "inconclusive"), "uncertain")).status).toBe("reviewed");
    } finally { f.db?.close(); }
  });

  it("fences wrong owner/file/decision version, future times and observations no later than implementation", async () => {
    const f = await fixture(kind);
    try {
      const active = await implemented(f);
      const input = observation(designPlan, { decisionId: active.id, decisionVersion: active.version });
      await expect(f.learning.recordEvidence({ ...f.scope, ownerId: "other" }, input, "foreign-owner")).rejects.toThrow("lesson_file_not_found");
      const otherFile = await f.repository.createLessonFile(scopeOwner, { notebookId: f.notebook.id, title: "另一课", type: "教案", document, pageCount: 1 });
      await expect(f.learning.recordEvidence({ ...f.scope, lessonFileId: otherFile.id }, input, "foreign-file")).rejects.toThrow("decision_not_found");
      await expect(f.learning.recordEvidence(f.scope, { ...input, decisionVersion: 2 }, "stale-version")).rejects.toThrow("stale_decision");
      await expect(f.learning.recordEvidence(f.scope, { ...input, synthetic: undefined }, "undeclared")).rejects.toThrow("decision_observation_context_required");
      await expect(f.learning.recordEvidence(f.scope, { ...input, observedAt: "2099-01-01T00:00:00.000Z" }, "future")).rejects.toThrow("learning_observation_in_future");
      const early = await f.learning.recordEvidence(f.scope, { ...input, observedAt: times.implementation }, "early");
      await expect(f.decisions.act(f.scope, active.id, reviewInput(early.id), "review-early")).rejects.toThrow("decision_review_evidence_before_implementation");
      const unrelated = await f.learning.recordEvidence({ ...f.scope, lessonFileId: otherFile.id }, observation(designPlan), "foreign-evidence");
      await expect(f.decisions.act(f.scope, active.id, reviewInput(unrelated.id), "review-foreign")).rejects.toThrow("decision_review_evidence_not_found");
    } finally { f.db?.close(); }
  });

  it("rejects a legacy future observation at review even when its association and criterion match", async () => {
    const f = await fixture(kind);
    try {
      const active = await implemented(f);
      const evidence: LearningEvidence = { ...observation(designPlan, { decisionId: active.id, decisionVersion: active.version }),
        observedAt: "2099-01-01T00:00:00.000Z", id: randomUUID(), ownerId: scopeOwner,
        notebookId: f.notebook.id, lessonFileId: f.file.id, createdAt: times.now };
      await f.repository.saveLearningEvidence(evidence, { idempotencyKey: "future", fingerprint: "future", documentVersion: 0, decisionVersion: active.version });
      await expect(f.decisions.act(f.scope, active.id, reviewInput(evidence.id), "review-future")).rejects.toThrow();
    } finally { f.db?.close(); }
  });

  it("requires a current document observation for design review after the lesson changes", async () => {
    const f = await fixture(kind);
    try {
      const active = await implemented(f);
      const evidence = await f.learning.recordEvidence(f.scope, observation(designPlan, { decisionId: active.id, decisionVersion: active.version }), "check");
      await f.repository.saveLessonDocument({ ownerId: scopeOwner, fileId: f.file.id, baseVersion: 0, document: { ...document, assessment: "已再次修改" }, pageCount: 1, source: "manual", idempotencyKey: "changed-document" });
      await expect(f.decisions.act(f.scope, active.id, reviewInput(evidence.id), "stale-check")).rejects.toThrow();
      expect((await f.decisions.act(f.scope, active.id, reviewInput(evidence.id, "inconclusive"), "uncertain")).review?.outcome).toBe("inconclusive");
    } finally { f.db?.close(); }
  });
});
