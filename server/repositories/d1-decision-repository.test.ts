import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createD1LessonCoreRepository } from "./d1-lesson-core-repository.js";
import { MemoryLessonRepository } from "./memory-repository.js";
import { DecisionService } from "../decisions/service.js";
import { lessonPlanSchema } from "../domain.js";
import type { LessonRepository } from "../repository.js";

import type { SqlDatabase, SqlResult, SqlStatement } from "../platform/sql-database.js";
import type { DecisionRecord, EvidenceCard } from "../decisions/contracts.js";
import { D1DecisionRepository } from "./d1-decision-repository.js";

class RecordingDatabase implements SqlDatabase {
  statements: SqlStatement[] = [];
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(): Promise<SqlResult<Row>> {
    return { rows: [], rowsAffected: 1 };
  }
  async batch<Row extends Record<string, unknown> = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<Row>[]> {
    this.statements.push(...statements);
    return statements.map(() => ({ rows: [], rowsAffected: 1 }));
  }
}

const record: DecisionRecord = {
  schemaVersion: 1, id: "decision-1", ownerId: "owner-1", notebookId: "notebook-1", lessonFileId: "lesson-1",
  unitId: null, lessonBlueprintId: null, decisionType: "goal_evidence", question: "证据是什么？",
  contextVersion: { documentVersion: 3, frameworkVersion: null },
  options: [{ id: "opt_a", statement: "A", tradeoffs: ["x"] }, { id: "opt_b", statement: "B", tradeoffs: ["y"] }],
  chosenOptionId: "opt_b", rationale: "理由",
  evidenceCardIds: ["card-1"], counterevidence: [], assumptions: [], uncertainties: [], confidence: 0.7,
  expectedSignal: "信号", falsifier: "证伪", reviewAt: null, status: "proposed", version: 1,
  rejection: null, implementation: null, review: null,
  provenance: { createdBy: "agent", modelRunId: "run-1", toolCallId: null, confirmedBy: null },
  createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z",
};
const card: EvidenceCard = {
  schemaVersion: 1, id: "card-1", kind: "curriculum_standard", level: "primary",
  source: { system: "standards", uri: "d1://standards/1", locator: "第 3 条", version: "2022", capturedAt: "2026-10-18T00:00:00Z" },
  excerpt: "原文", claim: "主张", supports: ["opt_b"], applicability: "适用", limitations: ["限制"],
  conflictsWith: [], confidence: 0.9, expiresAt: null, piiLevel: "none",
};

describe("D1DecisionRepository", () => {
  it("writes the document version into the insert guard so stale proposals cannot land", async () => {
    const database = new RecordingDatabase();
    const repository = new D1DecisionRepository(database);
    await repository.saveDecision(record, null, {
      idempotencyKey: "proposal-1", fingerprint: "fingerprint", documentVersion: 3,
      agentRun: { runId: "run-1", threadId: "thread-1", branchId: "branch-1" },
    }, [card]);
    const [decision, version, receipt, evidence] = database.statements;
    expect(decision.sql).toContain("INSERT INTO lesson_decisions");
    expect(decision.params).toContain(3);
    expect(version.sql).toContain("INSERT INTO lesson_decision_versions");
    expect(version.sql).toContain("changes() = 1");
    expect(evidence.sql).toContain("INSERT INTO lesson_evidence_cards");
    expect(evidence.sql).toContain("operation_idempotency");
    expect(receipt.sql).toContain("INSERT INTO operation_idempotency");
    expect(receipt.sql).toContain("changes() = 1");
    expect(receipt.sql).not.toContain("lesson_decision_versions");
  });

  it("uses the previous version for optimistic updates and keeps the version history append-only", async () => {
    const database = new RecordingDatabase();
    const repository = new D1DecisionRepository(database);
    await repository.saveDecision({ ...record, version: 2, status: "teacher_confirmed" }, 1, {
      idempotencyKey: "confirm-1", fingerprint: "fingerprint",
    }, []);
    const [update, version, receipt] = database.statements;
    expect(update.sql).toContain("UPDATE lesson_decisions");
    expect(update.params).toContain(1);
    expect(version.sql).toContain("INSERT INTO lesson_decision_versions");
    expect(receipt.sql).toContain("changes() = 1");
    expect(database.statements.some((statement) => statement.sql.includes("lesson_evidence_cards"))).toBe(false);
  });
});


async function cancellationFixture(kind: "sqlite" | "memory") {
  let db: DatabaseSync | undefined;
  let repository: LessonRepository;
  let beforeWrite: (() => Promise<void>) | undefined;
  if (kind === "sqlite") {
    db = new DatabaseSync(":memory:");
    const migrations = new URL("../../d1/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, migrations), "utf8"));
    db.prepare("INSERT INTO users VALUES (?, ?, 'dummy', 'now', 'now')").run("owner-1", "teacher");
    const execute = (statement: SqlStatement): SqlResult => {
      const prepared = db!.prepare(statement.sql);
      return prepared.columns().length
        ? { rows: prepared.all(...statement.params ?? []) as Record<string, unknown>[], rowsAffected: 0 }
        : { rows: [], rowsAffected: Number(prepared.run(...statement.params ?? []).changes) };
    };
    const sql = {
      query: async (statement: SqlStatement) => execute(statement),
      batch: async (statements: SqlStatement[]) => {
        if (statements.some(statement => statement.sql.includes("INSERT INTO lesson_decisions"))) {
          const hook = beforeWrite; beforeWrite = undefined; await hook?.();
        }
        db!.exec("BEGIN");
        try { const results = statements.map(execute); db!.exec("COMMIT"); return results; }
        catch (error) { db!.exec("ROLLBACK"); throw error; }
      },
    } as SqlDatabase;
    repository = createD1LessonCoreRepository(sql);
  } else {
    repository = new MemoryLessonRepository();
    const save = repository.saveDecision.bind(repository);
    repository.saveDecision = async (...args) => {
      const hook = beforeWrite; beforeWrite = undefined; await hook?.();
      return save(...args);
    };
  }
  const document = lessonPlanSchema.parse(Object.fromEntries(["unit", "period", "totalPeriods", "topic", "objectives", "focus", "preparation", "process", "assessment", "homework", "board", "reflection"].map(field => [field, "lesson text"])));
  const notebook = await repository.createNotebook("owner-1", { title: "语文", className: "一班", year: "2026", subject: "语文", tone: "teal" });
  const file = await repository.createLessonFile("owner-1", { notebookId: notebook.id, title: "课时", type: "教案", document, pageCount: 1 });
  const { thread, branch } = await repository.createThread("owner-1", { notebookId: notebook.id, resourceType: "lesson_file", lessonFileId: file.id });
  const run = await repository.createRun({ id: "run-1", ownerId: "owner-1", threadId: thread.id, branchId: branch.id, model: "test", status: "running", leaseToken: "lease-1", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  return { db, repository, file, thread, branch, run,
    beforeWrite: (hook: () => Promise<void>) => { beforeWrite = hook; },
    service: new DecisionService(repository), scope: { ownerId: "owner-1", lessonFileId: file.id },
    origin: { runId: run.id, threadId: thread.id, branchId: branch.id },
    proposal: { ...Object.fromEntries(["decisionType", "question", "options", "chosenOptionId", "rationale", "counterevidence", "assumptions", "uncertainties", "confidence", "expectedSignal", "falsifier", "reviewAt", "status"].map(field => [field, record[field as keyof DecisionRecord]])),
      contextVersion: { documentVersion: 0, frameworkVersion: null }, createdBy: "agent",
      evidenceCards: [{ ...Object.fromEntries(Object.entries(card).filter(([field]) => !["schemaVersion", "id"].includes(field))) }] },
  };
}

for (const kind of ["sqlite", "memory"] as const) describe(`${kind} atomic decision origin`, () => {
  for (const mismatch of ["missing", "run", "thread", "branch", "file"] as const) it(`rejects direct model insertion with ${mismatch} origin mismatch`, async () => {
    const f = await cancellationFixture(kind);
    try {
      const targetFile = mismatch === "file"
        ? await f.repository.createLessonFile("owner-1", { notebookId: f.file.notebookId, title: "another lesson", type: "教案", document: f.file.document, pageCount: 1 })
        : f.file;
      const agentRun = mismatch === "missing" ? undefined : {
        ...f.origin, ...(mismatch === "run" ? { runId: "another-run" } : {}),
        ...(mismatch === "thread" ? { threadId: "another-thread" } : {}),
        ...(mismatch === "branch" ? { branchId: "another-branch" } : {}),
      };
      await expect(f.repository.saveDecision({ ...record, notebookId: targetFile.notebookId, lessonFileId: targetFile.id,
        contextVersion: { documentVersion: 0, frameworkVersion: null } }, null,
      { idempotencyKey: "bypass", fingerprint: "bypass", documentVersion: 0, agentRun }, [card])).rejects.toThrow(/decision_scope_invalid|stale_decision/);
      expect(await f.repository.listDecisions("owner-1", targetFile.id, 10)).toEqual([]);
      expect(await f.repository.getDecisionCommandResult("owner-1", "bypass")).toBeNull();
    } finally { f.db?.close(); }
  });

  it("rejects a cancellation after origin preflight without writing a candidate, history, evidence or receipt", async () => {
    const f = await cancellationFixture(kind);
    try {
      // assertOrigin has already read running/no cancellation when this hook fires.
      let cancelled = false;
      f.beforeWrite(async () => { cancelled = await f.repository.requestRunCancellation("owner-1", f.run.id); });
      await expect(f.service.propose(f.scope, f.proposal, "racing-proposal", f.origin)).rejects.toThrow(/stale_decision|decision_scope_invalid/);
      expect(cancelled).toBe(true);
      expect(await f.repository.listDecisions("owner-1", f.file.id, 10)).toEqual([]);
      expect(await f.repository.listDecisionEvidenceCards("owner-1", f.file.id)).toEqual([]);
      expect(await f.repository.getDecisionCommandResult("owner-1", "racing-proposal")).toBeNull();
      if (f.db) expect(f.db.prepare("SELECT COUNT(*) AS n FROM lesson_decision_versions").get()?.n).toBe(0);
    } finally { f.db?.close(); }
  });

  it("hides a persisted candidate if cancellation wins at settlement and refuses confirmation", async () => {
    const f = await cancellationFixture(kind);
    try {
      const decision = await f.service.propose(f.scope, f.proposal, "proposal", f.origin);
      await f.repository.requestRunCancellation("owner-1", f.run.id);
      await expect(f.repository.settleRun({ ownerId: "owner-1", runId: f.run.id, leaseToken: "lease-1", status: "completed" })).rejects.toThrow("run_cancel_requested");
      expect((await f.service.read(f.scope)).decisions).toEqual([]);
      await expect(f.service.act(f.scope, decision.id, { action: "confirm", expectedVersion: 1, chosenOptionId: "opt_b" }, "confirm")).rejects.toThrow("decision_proposal_not_delivered");
      // Defensive read for historical completed+cancel flag rows from the old race.
      await f.repository.updateRun("owner-1", f.run.id, { status: "completed", leaseToken: undefined });
      expect((await f.service.read(f.scope)).decisions).toEqual([]);
      await expect(f.service.readContext(f.scope, decision.id)).rejects.toThrow("decision_proposal_not_delivered");
    } finally { f.db?.close(); }
  });

  it("retains exact idempotent proposal replay and delivers only uncancelled completion", async () => {
    const f = await cancellationFixture(kind);
    try {
      const decision = await f.service.propose(f.scope, f.proposal, "proposal", f.origin);
      expect((await f.service.read(f.scope)).decisions).toEqual([]);
      await f.repository.settleRun({ ownerId: "owner-1", runId: f.run.id, leaseToken: "lease-1", status: "completed" });
      expect(await f.repository.requestRunCancellation("owner-1", f.run.id)).toBe(false);
      expect(await f.service.propose(f.scope, f.proposal, "proposal", f.origin)).toEqual(decision);
      expect((await f.service.read(f.scope)).decisions.map(item => item.id)).toEqual([decision.id]);
    } finally { f.db?.close(); }
  });
});
