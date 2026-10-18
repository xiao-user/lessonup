import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lessonFieldSchema, lessonPlanSchema } from "../domain.js";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { createD1LessonCoreRepository } from "../repositories/d1-lesson-core-repository.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase, SqlStatement } from "../platform/sql-database.js";
import { LearningService } from "./service.js";

const document = lessonPlanSchema.parse(Object.fromEntries(lessonFieldSchema.options.map((field) => [field, "真实教案"] )));
const baselineInput = {
  documentVersion: 0, objective: "用数轴解释有理数大小", task: "独立在数轴标点并解释比较依据", criterion: "能说明方向与位置的比较依据",
  learnerGroup: "七年级一班全班", observation: "12名学生中4名能独立解释，其余主要复述结论", method: "assessment" as const,
  observedAt: "2026-10-17T01:00:00.000Z", sourceReference: "课堂出口条汇总", sampleSize: 12, meetingCriterion: 4,
  synthetic: false, conditions: "同等难度数轴任务、独立作答、无提示、5分钟",
};
const proposal = {
  documentVersion: 0, hypothesis: "学生还没有把左右位置与大小关系联系起来", alternativeExplanation: "也可能是书面表达负担而非概念不理解",
  intervention: "用反例比较并请学生先口头解释，再写一句依据", expectedSignal: "独立解释位置与大小联系的学生增加",
  checkPlan: "使用同一成功判据检查下一次独立作答，保留未达成样本",
};

async function fixture(kind: "memory" | "sqlite") {
  let time = "2026-10-17T02:00:00.000Z";
  let db: DatabaseSync | undefined;
  let fail = false;
  let repository: LessonRepository;
  if (kind === "sqlite") {
    db = new DatabaseSync(":memory:");
    const directory = new URL("../../d1/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, directory), "utf8"));
    for (const owner of ["teacher", "other"]) db.prepare("INSERT INTO users VALUES (?, ?, 'dummy', 'now', 'now')").run(owner, owner);
    const execute = (statement: SqlStatement) => {
      const prepared = db!.prepare(statement.sql);
      return prepared.columns().length
        ? { rows: prepared.all(...statement.params ?? []), rowsAffected: 0 }
        : { rows: [], rowsAffected: Number(prepared.run(...statement.params ?? []).changes) };
    };
    const port = {
      query: async (statement: SqlStatement) => execute(statement),
      batch: async (statements: SqlStatement[]) => {
        db!.exec("BEGIN");
        try {
          const result = statements.map((statement, index) => { if (fail && index === 1) throw new Error("injected_failure"); return execute(statement); });
          db!.exec("COMMIT"); return result;
        } catch (error) { db!.exec("ROLLBACK"); throw error; }
      },
    } as SqlDatabase;
    repository = createD1LessonCoreRepository(port, () => time);
  } else repository = new MemoryLessonRepository();
  const notebook = await repository.createNotebook("teacher", { title: "数学", className: "一班", year: "2026", subject: "数学", tone: "teal" });
  const file = await repository.createLessonFile("teacher", { notebookId: notebook.id, title: "有理数", type: "教案", document, pageCount: 1 });
  const scope = { ownerId: "teacher", lessonFileId: file.id };
  const service = new LearningService(repository, () => time);
  return { repository, scope, service, db, setTime: (value: string) => { time = value; }, fail: (value: boolean) => { fail = value; } };
}

for (const kind of ["memory", "sqlite"] as const) describe(`${kind} learning evidence lifecycle`, () => {
  it("pages tied timestamps without duplicates and retrieves selected evidence outside the default window", async () => {
    const f = await fixture(kind);
    try {
      for (let index = 0; index < 45; index += 1) await f.service.recordEvidence(f.scope, baselineInput, `evidence-${index}`);
      const first = await f.service.read(f.scope);
      const second = await f.service.read(f.scope, { evidenceBefore: first.next.evidence });
      expect(first.evidence).toHaveLength(40); expect(second.evidence).toHaveLength(5);
      expect(new Set([...first.evidence, ...second.evidence].map((item) => item.id)).size).toBe(45);
      expect(second.next.evidence).toBeNull();
      const baseline = second.evidence[0]!;
      for (let index = 0; index < 27; index += 1) await f.service.propose(f.scope, { ...proposal, baselineEvidenceId: baseline.id }, `inquiry-${index}`);
      const page = await f.service.read(f.scope);
      const older = await f.service.read(f.scope, { inquiriesBefore: page.next.inquiries });
      expect(page.inquiries).toHaveLength(24); expect(older.inquiries).toHaveLength(3);
      expect(new Set([...page.inquiries, ...older.inquiries].map((item) => item.id)).size).toBe(27);
      const context = await f.service.readContext(f.scope, { inquiryId: older.inquiries[0]!.id });
      expect(context.evidence).toEqual([baseline]);
      expect(context.lesson).toMatchObject({ documentVersion: 0, objectives: document.objectives, assessment: document.assessment });
      await expect(f.service.readContext({ ...f.scope, ownerId: "other" }, { evidenceId: baseline.id })).rejects.toThrow("lesson_file_not_found");
      if (f.db) {
        const plan = f.db.prepare("EXPLAIN QUERY PLAN SELECT record_json FROM learning_evidence WHERE owner_id = ? AND lesson_file_id = ? AND (observed_at, id) < (?, ?) ORDER BY observed_at DESC, id DESC LIMIT 41").all(f.scope.ownerId, f.scope.lessonFileId, baseline.observedAt, baseline.id);
        expect(JSON.stringify(plan)).toContain("learning_evidence_file_idx");
        expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
      }
    } finally { f.db?.close(); }
  });

  it("separates proposal, adoption, implementation, follow-up evidence and teacher review", async () => {
    const f = await fixture(kind);
    try {
      const baseline = await f.service.recordEvidence(f.scope, baselineInput, "baseline");
      const draft = await f.service.propose(f.scope, { ...proposal, baselineEvidenceId: baseline.id }, "draft");
      expect(draft.state).toBe("proposed");
      const adopted = await f.service.act(f.scope, draft.id, { action: "adopt", expectedVersion: 0 }, "adopt");
      expect(adopted.implementedAt).toBeUndefined();
      await expect(f.service.act(f.scope, draft.id, { action: "review", expectedVersion: 1,
        review: { evidenceId: baseline.id, outcome: "supported", rationale: "不能用基线证明改进", limitations: "没有后测" } }, "bad-review")).rejects.toThrow("learning_transition_invalid");
      const implemented = await f.service.act(f.scope, draft.id, { action: "implement", expectedVersion: 1 }, "implement");
      f.setTime("2026-10-17T03:00:00.000Z");
      const followup = await f.service.recordEvidence(f.scope, { ...baselineInput, inquiryId: draft.id,
        observedAt: "2026-10-17T02:30:00.000Z", observation: "同一组12名学生中8名能独立解释", meetingCriterion: 8 }, "followup");
      const review = { evidenceId: followup.id, outcome: "supported", rationale: "同一判据下独立解释增加，符合预期信号", limitations: "任务熟悉度和教师提示可能影响表现，不能证明因果效果" };
      const recommendation = await f.service.act(f.scope, draft.id, { action: "propose_review", expectedVersion: implemented.version, review }, "recommend");
      expect(recommendation.state).toBe("implemented");
      expect(recommendation.review).toBeUndefined();
      const reviewed = await f.service.act(f.scope, draft.id, { action: "review", expectedVersion: recommendation.version, review }, "review");
      expect(reviewed).toMatchObject({ state: "reviewed", review, version: 4 });
      const nextCycle = await f.service.propose(f.scope, { ...proposal, baselineEvidenceId: followup.id }, "next-cycle");
      expect(nextCycle).toMatchObject({ baselineEvidenceId: followup.id, state: "proposed" });
      const summaries = await f.repository.listLearningReviews(f.scope.ownerId, { lessonFileId: f.scope.lessonFileId, limit: 4 });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ inquiryId: draft.id, baseline, followup, review });
      expect(summaries[0]).not.toHaveProperty("proposedReview");
      expect(await f.repository.listLearningReviews("other", { lessonFileId: f.scope.lessonFileId, limit: 4 })).toEqual([]);
      expect((await f.service.read(f.scope)).evidence).toHaveLength(2);
      expect(await f.service.act(f.scope, draft.id, { action: "adopt", expectedVersion: 0 }, "adopt")).toEqual(adopted);
      await expect(f.service.act(f.scope, draft.id, { action: "dismiss", expectedVersion: 4 }, "dismiss")).rejects.toThrow("learning_transition_invalid");
    } finally { f.db?.close(); }
  });

  it("fences stale and concurrent decisions and protects evidence provenance", async () => {
    const f = await fixture(kind);
    try {
      const evidence = await f.service.recordEvidence(f.scope, baselineInput, "evidence");
      expect(await f.service.recordEvidence(f.scope, baselineInput, "evidence")).toEqual(evidence);
      await expect(f.service.recordEvidence(f.scope, { ...baselineInput, observation: "不同观察" }, "evidence")).rejects.toThrow("idempotency_conflict");
      const draft = await f.service.propose(f.scope, { ...proposal, baselineEvidenceId: evidence.id }, "draft");
      const results = await Promise.allSettled([
        f.service.act(f.scope, draft.id, { action: "adopt", expectedVersion: 0 }, "adopt-1"),
        f.service.act(f.scope, draft.id, { action: "dismiss", expectedVersion: 0 }, "dismiss-1"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      await expect(f.service.propose({ ...f.scope, ownerId: "other" }, { ...proposal, baselineEvidenceId: evidence.id }, "foreign")).rejects.toThrow("lesson_file_not_found");
      await expect(f.service.recordEvidence(f.scope, { ...baselineInput, observedAt: "2099-01-01T00:00:00.000Z" }, "future")).rejects.toThrow("learning_observation_in_future");
      await expect(f.service.recordEvidence(f.scope, { ...baselineInput, meetingCriterion: 13 }, "bad-count")).rejects.toThrow();
      expect(await f.repository.getLearningEvidence("other", evidence.id)).toBeNull();
    } finally { f.db?.close(); }
  });

  it("does not turn incomparable or pre-implementation evidence into a positive result", async () => {
    const f = await fixture(kind);
    try {
      const evidence = await f.service.recordEvidence(f.scope, baselineInput, "baseline");
      const inquiry = await f.service.propose(f.scope, { ...proposal, baselineEvidenceId: evidence.id }, "draft");
      await expect(f.service.recordEvidence(f.scope, { ...baselineInput, inquiryId: inquiry.id }, "early")).rejects.toThrow("learning_inquiry_not_implemented");
      await f.service.act(f.scope, inquiry.id, { action: "adopt", expectedVersion: 0 }, "adopt");
      await f.service.act(f.scope, inquiry.id, { action: "implement", expectedVersion: 1 }, "implement");
      await expect(f.service.recordEvidence(f.scope, { ...baselineInput, inquiryId: inquiry.id }, "before")).rejects.toThrow("learning_evidence_before_implementation");
      f.setTime("2026-10-17T03:00:00.000Z");
      const followup = await f.service.recordEvidence(f.scope, { ...baselineInput, inquiryId: inquiry.id, learnerGroup: "另一个班",
        observedAt: "2026-10-17T02:30:00.000Z" }, "followup");
      const review = { evidenceId: followup.id, outcome: "supported", rationale: "样本不同不能证明改善", limitations: "观察群体不一致" };
      await expect(f.service.act(f.scope, inquiry.id, { action: "review", expectedVersion: 2, review }, "bad-review")).rejects.toThrow("learning_evidence_not_comparable");
      expect((await f.service.act(f.scope, inquiry.id, { action: "review", expectedVersion: 2,
        review: { ...review, outcome: "inconclusive" } }, "review")).state).toBe("reviewed");
    } finally { f.db?.close(); }
  });

  it("does not expose or adopt an Agent proposal from an unfinished or cancelled run", async () => {
    const f = await fixture(kind);
    try {
      const file = (await f.repository.getLessonFile(f.scope.ownerId, f.scope.lessonFileId))!;
      const { thread, branch } = await f.repository.createThread(f.scope.ownerId, { notebookId: file.notebookId, lessonFileId: file.id });
      const runId = crypto.randomUUID();
      await f.repository.createRun({ id: runId, ownerId: f.scope.ownerId, threadId: thread.id, branchId: branch.id, model: "test", status: "running", startedAt: "2026-10-17T02:00:00.000Z" });
      const baseline = await f.service.recordEvidence(f.scope, baselineInput, "baseline");
      const draft = await f.service.propose(f.scope, { ...proposal, baselineEvidenceId: baseline.id }, "agent-draft", { runId, threadId: thread.id, branchId: branch.id });
      expect((await f.service.read(f.scope)).inquiries).toHaveLength(0);
      await expect(f.service.act(f.scope, draft.id, { action: "adopt", expectedVersion: 0 }, "too-early")).rejects.toThrow("learning_proposal_not_delivered");
      await f.repository.updateRun(f.scope.ownerId, runId, { status: "cancelled" });
      expect((await f.service.read(f.scope)).inquiries).toHaveLength(0);
      await expect(f.service.act(f.scope, draft.id, { action: "adopt", expectedVersion: 0 }, "cancelled")).rejects.toThrow("learning_proposal_not_delivered");
    } finally { f.db?.close(); }
  });

  it("rolls back partial SQL writes and cascades deleted lesson resources", async () => {
    const f = await fixture(kind);
    try {
      const evidence = await f.service.recordEvidence(f.scope, baselineInput, "baseline");
      if (kind === "sqlite") {
        f.fail(true);
        await expect(f.service.propose(f.scope, { ...proposal, baselineEvidenceId: evidence.id }, "draft")).rejects.toThrow("injected_failure");
        expect((await f.service.read(f.scope)).inquiries).toHaveLength(0);
        f.fail(false);
      }
      const inquiry = await f.service.propose(f.scope, { ...proposal, baselineEvidenceId: evidence.id }, "draft");
      await f.repository.deleteLessonFile(f.scope.ownerId, f.scope.lessonFileId);
      expect(await f.repository.getLearningEvidence(f.scope.ownerId, evidence.id)).toBeNull();
      expect(await f.repository.getLearningInquiry(f.scope.ownerId, inquiry.id)).toBeNull();
      await expect(f.service.recordEvidence(f.scope, baselineInput, "baseline")).rejects.toThrow("lesson_file_not_found");
    } finally { f.db?.close(); }
  });
});
