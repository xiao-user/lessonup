import { describe, expect, it } from "vitest";

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
    }, [card]);
    const [decision, version, evidence, receipt] = database.statements;
    expect(decision.sql).toContain("INSERT INTO lesson_decisions");
    expect(decision.params).toContain(3);
    expect(version.sql).toContain("INSERT INTO lesson_decision_versions");
    expect(version.sql).toContain("changes() = 1");
    expect(evidence.sql).toContain("INSERT INTO lesson_evidence_cards");
    expect(evidence.sql).toContain("version = ?");
    expect(receipt.sql).toContain("INSERT INTO operation_idempotency");
    expect(receipt.sql).toContain("lesson_decision_versions");
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
    expect(receipt.sql).toContain("lesson_decision_versions");
    expect(database.statements.some((statement) => statement.sql.includes("lesson_evidence_cards"))).toBe(false);
  });
});
