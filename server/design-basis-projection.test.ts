import { describe, expect, it } from "vitest";

import type {
  LessonDesignBasisAggregate,
  LessonFileRecord,
} from "./domain.js";
import {
  assertDesignBasisProjectionCurrent,
  materializeDesignBasisProjection,
} from "./design-basis-projection.js";
import { materializeLessonDesignChange } from "./lesson-design-change.js";

const basisId = "00000000-0000-4000-8000-00000000b001";
const entryId = "00000000-0000-4000-8000-00000000e001";

const aggregate = (): LessonDesignBasisAggregate => ({
  basis: {
    id: basisId,
    ownerId: "00000000-0000-4000-8000-000000000001",
    notebookId: "notebook-a",
    lessonFileId: "file-a",
    frameworkId: null,
    semesterUnitId: null,
    lessonBlueprintId: null,
    catalogReleaseId: null,
    textbookId: null,
    curriculumNodeId: null,
    semanticReleaseId: null,
    sourceFrameworkVersion: null,
    sourceBlueprintVersion: null,
    learnerContext: { learnerProfile: "学生容易只记结论" },
    teacherNotes: "",
    status: "confirmed",
    version: 2,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  },
  entries: [{
    id: entryId,
    basisId,
    kind: "student_difficulty",
    semanticEntityId: null,
    semanticEntityName: null,
    relatedSemanticEntityId: null,
    relatedSemanticEntityName: null,
    relatedCurriculumNodeId: null,
    relatedCurriculumNodeTitle: null,
    statement: "学生可能只记住轴对称定义，不能说明判断依据。",
    rationale: "需要在判断题后追问理由。",
    evidence: [{ id: "teacher-observation", title: "课堂观察", kind: "private" }],
    decision: "accepted",
    teacherConfirmed: true,
    origin: "teacher",
    sortNo: 1,
    version: 3,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  }],
});

const file = (): LessonFileRecord => ({
  id: "file-a",
  ownerId: "00000000-0000-4000-8000-000000000001",
  notebookId: "notebook-a",
  title: "轴对称",
  type: "概念课",
  document: {
    unit: "第一单元",
    period: "第 1 课时",
    totalPeriods: "共 2 课时",
    topic: "轴对称",
    objectives: "理解轴对称。",
    knowledgePoints: "轴对称的概念与判定",
    continuity: "",
    focus: "准确判断。",
    preparation: "方格纸。",
    process: "观察图形并判断。",
    assessment: "完成判断题。",
    homework: "练习一。",
    board: "轴对称",
    reflection: "",
  },
  contextProfile: {},
  documentVersion: 4,
  pageCount: 1,
  updatedAt: "2026-08-02T00:00:00.000Z",
});

describe("design basis projection", () => {
  it("materializes one approval that creates a decision and updates A4", () => {
    const patch = materializeLessonDesignChange({
      aggregate: aggregate(),
      file: file(),
      proposal: {
        summary: "补充学生困难并完善评价",
        designBasisOperations: [{
          op: "create_design_basis_entry",
          referenceKey: "evidence-gap",
          kind: "student_difficulty",
          semanticEntityId: null,
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "学生可能只给出判断结论。",
          rationale: "需要观察能否说明依据。",
          evidenceSourceIds: [],
          decision: "accepted",
        }],
        documentOperations: [{
          field: "assessment",
          replacement: "完成判断题，并说明判断所依据的图形特征。",
          basisEntryIds: [],
          createdBasisEntryRefs: ["evidence-gap"],
          usesLearnerContext: false,
        }],
      },
      timestamp: "2026-08-02T01:00:00.000Z",
    });

    const created = patch.designBasisPatch.operations.find((operation) => (
      operation.op === "create_design_basis_entry"
    ));
    expect(created?.op).toBe("create_design_basis_entry");
    if (!created || created.op !== "create_design_basis_entry") return;
    expect(patch.operations).toEqual([
      expect.objectContaining({
        field: "assessment",
        expectedText: "完成判断题。",
        replacement: "完成判断题，并说明判断所依据的图形特征。",
      }),
    ]);
    expect(patch.projection).toMatchObject({
      baseBasisVersion: 3,
      entryRefs: [{
        entryId: created.entryId,
        expectedVersion: 0,
        expectedStatement: "学生可能只给出判断结论。",
      }],
      operationMappings: [{ entryIds: [created.entryId] }],
    });
  });

  it("rejects a document reference that does not name a created decision", () => {
    expect(() => materializeLessonDesignChange({
      aggregate: aggregate(),
      file: file(),
      proposal: {
        summary: "无效关联",
        designBasisOperations: [{
          op: "create_design_basis_entry",
          referenceKey: "known",
          kind: "student_difficulty",
          semanticEntityId: null,
          relatedSemanticEntityId: null,
          relatedCurriculumNodeId: null,
          statement: "学生容易遗漏依据。",
          rationale: "",
          evidenceSourceIds: [],
          decision: "accepted",
        }],
        documentOperations: [{
          field: "assessment",
          replacement: "完成判断题并说明依据。",
          basisEntryIds: [],
          createdBasisEntryRefs: ["missing"],
          usesLearnerContext: false,
        }],
      },
    })).toThrow();
  });

  it("materializes an auditable A4 patch from confirmed decisions", () => {
    const patch = materializeDesignBasisProjection({
      aggregate: aggregate(),
      file: file(),
      proposal: {
        summary: "把学生困难落实到评价",
        operations: [{
          field: "assessment",
          replacement: "完成判断题，并口头说明每次判断的依据。",
          basisEntryIds: [entryId],
          usesLearnerContext: true,
        }],
      },
    });

    expect(patch).toMatchObject({
      fileId: "file-a",
      baseDocumentVersion: 4,
      citations: [{ id: "teacher-observation" }],
      projection: {
        basisId,
        baseBasisVersion: 2,
        entryRefs: [{ entryId, expectedVersion: 3 }],
        expectedLearnerContext: { learnerProfile: "学生容易只记结论" },
        operationMappings: [{ operationIndex: 0, entryIds: [entryId], usesLearnerContext: true }],
      },
    });
  });

  it("allows unrelated basis chronology changes but rejects a changed referenced entry", () => {
    const original = aggregate();
    const patch = materializeDesignBasisProjection({
      aggregate: original,
      file: file(),
      proposal: {
        summary: "落实困难",
        operations: [{
          field: "process",
          replacement: "观察图形、判断，并说明判断依据。",
          basisEntryIds: [entryId],
          usesLearnerContext: false,
        }],
      },
    });
    const unrelatedChange = aggregate();
    unrelatedChange.basis.version = 9;
    unrelatedChange.basis.teacherNotes = "另一项备注";
    expect(() => assertDesignBasisProjectionCurrent(patch, unrelatedChange)).not.toThrow();

    unrelatedChange.entries[0].version += 1;
    expect(() => assertDesignBasisProjectionCurrent(patch, unrelatedChange))
      .toThrow("投影所依据的教学决定已经变化");
  });

  it("rejects unconfirmed decisions and non-instructional metadata targets", () => {
    const unconfirmed = aggregate();
    unconfirmed.entries[0].teacherConfirmed = false;
    expect(() => materializeDesignBasisProjection({
      aggregate: unconfirmed,
      file: file(),
      proposal: {
        summary: "错误投影",
        operations: [{
          field: "assessment",
          replacement: "增加说明理由。",
          basisEntryIds: [entryId],
          usesLearnerContext: false,
        }],
      },
    })).toThrow("只能投影当前已确认且仍被接受的设计依据");

    expect(() => materializeDesignBasisProjection({
      aggregate: aggregate(),
      file: file(),
      proposal: {
        summary: "错误字段",
        operations: [{
          field: "unit",
          replacement: "第二单元",
          basisEntryIds: [entryId],
          usesLearnerContext: false,
        }],
      },
    })).toThrow("不是设计依据可直接投影的课堂执行栏目");
  });
});
