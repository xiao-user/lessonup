import { describe, expect, it } from "vitest";

import {
  lessonDesignBasisPatchSchema,
  type LessonDesignBasisAggregate,
} from "./domain.js";
import {
  applyLessonDesignBasisPatch,
  materializeLessonDesignBasisPatch,
} from "./lesson-design-basis-patch.js";

const basis = (): LessonDesignBasisAggregate => ({
  basis: {
    id: "00000000-0000-4000-8000-00000000b001",
    ownerId: "00000000-0000-4000-8000-000000000001",
    notebookId: "notebook-a",
    lessonFileId: "file-a",
    frameworkId: null,
    semesterUnitId: null,
    lessonBlueprintId: null,
    catalogReleaseId: "00000000-0000-4000-8000-00000000c001",
    textbookId: "textbook-a",
    curriculumNodeId: "node-a",
    semanticReleaseId: "00000000-0000-4000-8000-00000000d001",
    sourceFrameworkVersion: null,
    sourceBlueprintVersion: null,
    learnerContext: {},
    teacherNotes: "",
    status: "draft",
    version: 0,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  },
  entries: [],
});

describe("lesson design basis ResourcePatch", () => {
  it("rejects a scalar learner context before it reaches persistence", () => {
    expect(() => lessonDesignBasisPatchSchema.parse({
      basisId: "00000000-0000-4000-8000-00000000b001",
      fileId: "file-a",
      baseBasisVersion: 0,
      summary: "错误的学情类型",
      operations: [{
        op: "replace_design_basis_field",
        field: "learnerContext",
        expectedValue: {},
        replacement: "七年级学生",
      }],
    })).toThrow();
  });

  it("binds observed evidence and persists a teacher-confirmed decision", () => {
    const aggregate = basis();
    const patch = materializeLessonDesignBasisPatch({
      aggregate,
      observedEvidence: [{
        ownerId: aggregate.basis.ownerId,
        runId: "00000000-0000-4000-8000-000000000099",
        kind: "curriculum_knowledge",
        source: { id: "source-a", title: "教材知识点样本", kind: "public" },
        createdAt: "2026-08-02T00:00:00.000Z",
      }],
      proposal: {
        summary: "确认本课知识点",
        operations: [{
          op: "create_design_basis_entry",
          kind: "knowledge_point",
          semanticEntityId: "00000000-0000-4000-8000-00000000e001",
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "学生能够结合语境分析景物描写。",
          rationale: "与本课主要活动直接一致。",
          evidenceSourceIds: ["source-a"],
          decision: "accepted",
        }],
      },
    });

    const updated = applyLessonDesignBasisPatch(
      aggregate,
      patch,
      "2026-08-02T01:00:00.000Z",
    );
    expect(updated.basis.version).toBe(1);
    expect(updated.entries).toEqual([
      expect.objectContaining({
        kind: "knowledge_point",
        statement: "学生能够结合语境分析景物描写。",
        teacherConfirmed: true,
        evidence: [{ id: "source-a", title: "教材知识点样本", kind: "public" }],
      }),
    ]);
  });

  it("rejects evidence the current run did not observe", () => {
    expect(() => materializeLessonDesignBasisPatch({
      aggregate: basis(),
      proposal: {
        summary: "保存未经读取的来源",
        operations: [{
          op: "create_design_basis_entry",
          kind: "knowledge_point",
          semanticEntityId: "00000000-0000-4000-8000-00000000e001",
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "错误结论",
          rationale: "",
          evidenceSourceIds: ["not-observed"],
          decision: "accepted",
        }],
      },
    })).toThrow("unobserved_design_basis_evidence");
  });

  it("does not let agent-created curriculum decisions bypass current-run evidence", () => {
    expect(() => materializeLessonDesignBasisPatch({
      aggregate: basis(),
      proposal: {
        summary: "缺少教材证据",
        operations: [{
          op: "create_design_basis_entry",
          kind: "knowledge_point",
          semanticEntityId: "00000000-0000-4000-8000-00000000e001",
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "未经本轮读取的知识点",
          rationale: "",
          evidenceSourceIds: [],
          decision: "accepted",
        }],
      },
    })).toThrow("design_basis_evidence_required");
  });

  it("stores a general classroom decision without forcing it into a knowledge category", () => {
    const aggregate = basis();
    const patch = materializeLessonDesignBasisPatch({
      aggregate,
      proposal: {
        summary: "记录课堂组织决定",
        operations: [{
          op: "create_design_basis_entry",
          kind: "teaching_decision",
          semanticEntityId: null,
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "先独立批注，再进行同伴证据核对。",
          rationale: "避免讨论先入为主，同时保留每位学生的初始判断。",
          evidenceSourceIds: [],
          decision: "accepted",
        }],
      },
    });

    expect(applyLessonDesignBasisPatch(
      aggregate,
      patch,
      "2026-08-02T02:00:00.000Z",
    ).entries[0]).toMatchObject({
      kind: "teaching_decision",
      statement: "先独立批注，再进行同伴证据核对。",
      teacherConfirmed: true,
    });
  });
});
