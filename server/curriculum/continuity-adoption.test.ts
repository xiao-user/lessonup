import { describe, expect, it } from "vitest";
import {
  applyContinuityDecisions,
  buildContinuityWritebackHints,
  buildContinuityWritebackSeed,
  continuityFingerprintFromCandidateId,
  findNextUnitBlueprint,
  needsContinuityWriteback,
  parseContinuityWritebackFeedbackId,
  resolveScopedWritebackFeedbackId,
  selectContinuityForDraft,
} from "./continuity-adoption.js";

describe("continuity adoption helpers", () => {
  it("prefers accepted candidates and drops dismissed ones from drafts", () => {
    const selected = selectContinuityForDraft([
      {
        direction: "review",
        decision: "dismissed",
        evidenceKind: "same_knowledge_point",
        relatedPointName: "旧A",
        currentPointName: "新A",
      },
      {
        direction: "review",
        decision: "accepted",
        evidenceKind: "lexical_similarity",
        relatedPointName: "旧B",
        currentPointName: "新B",
      },
      {
        direction: "review",
        decision: "candidate",
        evidenceKind: "same_knowledge_point",
        relatedPointName: "旧C",
        currentPointName: "新C",
      },
      {
        direction: "prepare",
        decision: "candidate",
        evidenceKind: "approved_relation",
        relatedPointName: "后D",
        currentPointName: "新D",
      },
    ]);
    expect(selected).toEqual([
      expect.objectContaining({ relatedPointName: "旧B", decision: "accepted" }),
      expect.objectContaining({ relatedPointName: "后D" }),
    ]);
  });

  it("applies fingerprint decisions onto ephemeral lexical candidates", () => {
    const applied = applyContinuityDecisions(
      [{ fingerprint: "abc", decision: "candidate" as const }],
      new Map([["abc", "accepted"]]),
    );
    expect(applied[0]?.decision).toBe("accepted");
    expect(continuityFingerprintFromCandidateId("lexical-abc")).toBe("abc");
  });

  it("selects the same-unit plannedPeriod successor for writeback", () => {
    const blueprints = [
      { id: "bp-1", semesterUnitId: "u1", plannedPeriod: 1 },
      { id: "bp-2", semesterUnitId: "u1", plannedPeriod: 2 },
      { id: "bp-other", semesterUnitId: "u2", plannedPeriod: 2 },
    ];
    expect(findNextUnitBlueprint(blueprints, "bp-1")?.id).toBe("bp-2");
    expect(findNextUnitBlueprint(blueprints, "bp-2")).toBeNull();
    expect(needsContinuityWriteback({
      kind: "continuity_outcome",
      continuityOutcome: "weak",
      writebackStatus: "pending",
    })).toBe(true);
    expect(needsContinuityWriteback({
      kind: "observation",
      continuityOutcome: null,
      writebackStatus: null,
    })).toBe(false);
  });

  it("builds writeback hints only for weak or skipped continuity outcomes", () => {
    const hints = buildContinuityWritebackHints(
      [
        {
          id: "fb-weak",
          notebookId: "n1",
          lessonFileId: "lf-1",
          lessonBlueprintId: "bp-1",
          semesterFrameworkId: "fw-1",
          kind: "continuity_outcome",
          statement: "复习写景顺序时只有半数能独立完成",
          relatedEntityId: null,
          continuityFingerprint: "fp-1",
          continuityDirection: "review",
          continuityOutcome: "weak",
          writebackStatus: "pending",
          evidence: {},
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
        {
          id: "fb-ok",
          notebookId: "n1",
          lessonFileId: "lf-1",
          lessonBlueprintId: "bp-1",
          semesterFrameworkId: "fw-1",
          kind: "continuity_outcome",
          statement: "铺垫有效",
          relatedEntityId: null,
          continuityFingerprint: "fp-2",
          continuityDirection: "prepare",
          continuityOutcome: "worked",
          writebackStatus: "not_applicable",
          evidence: {},
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
      [
        {
          id: "bp-1",
          frameworkId: "fw-1",
          semesterUnitId: "u1",
          curriculumNodeId: "ch1-1",
          chapterPeriodNo: 1,
          plannedPeriod: 1,
          sortNo: 1,
          title: "第1课时",
          mainActivity: "活动1",
          observableProduct: "产出1",
          assessmentEvidence: "证据1",
          anticipatedDifficulties: [],
          plannedMinutes: 40,
          teacherNotes: "",
          status: "taught",
          version: 1,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
        {
          id: "bp-2",
          frameworkId: "fw-1",
          semesterUnitId: "u1",
          curriculumNodeId: "ch1-1",
          chapterPeriodNo: 2,
          plannedPeriod: 2,
          sortNo: 2,
          title: "第2课时",
          mainActivity: "活动2",
          observableProduct: "产出2",
          assessmentEvidence: "证据2",
          anticipatedDifficulties: [],
          plannedMinutes: 40,
          teacherNotes: "",
          status: "draft",
          version: 0,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      feedbackId: "fb-weak",
      statement: "复习写景顺序时只有半数能独立完成",
      nextBlueprint: expect.objectContaining({ id: "bp-2", title: "第2课时" }),
    });
  });

  it("excludes applied feedback from writeback hints", () => {
    const hints = buildContinuityWritebackHints(
      [
        {
          id: "fb-applied",
          notebookId: "n1",
          lessonFileId: "lf-1",
          lessonBlueprintId: "bp-1",
          semesterFrameworkId: "fw-1",
          kind: "continuity_outcome",
          statement: "已回写的薄弱衔接",
          relatedEntityId: null,
          continuityFingerprint: "fp-1",
          continuityDirection: "review",
          continuityOutcome: "weak",
          writebackStatus: "applied",
          evidence: {},
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
        {
          id: "fb-pending",
          notebookId: "n1",
          lessonFileId: "lf-1",
          lessonBlueprintId: "bp-1",
          semesterFrameworkId: "fw-1",
          kind: "continuity_outcome",
          statement: "仍待回写",
          relatedEntityId: null,
          continuityFingerprint: "fp-2",
          continuityDirection: "review",
          continuityOutcome: "skipped",
          writebackStatus: "pending",
          evidence: {},
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
      [
        {
          id: "bp-1",
          frameworkId: "fw-1",
          semesterUnitId: "u1",
          curriculumNodeId: "ch1-1",
          chapterPeriodNo: 1,
          plannedPeriod: 1,
          sortNo: 1,
          title: "第1课时",
          mainActivity: "活动1",
          observableProduct: "产出1",
          assessmentEvidence: "证据1",
          anticipatedDifficulties: [],
          plannedMinutes: 40,
          teacherNotes: "",
          status: "taught",
          version: 1,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
        {
          id: "bp-2",
          frameworkId: "fw-1",
          semesterUnitId: "u1",
          curriculumNodeId: "ch1-1",
          chapterPeriodNo: 2,
          plannedPeriod: 2,
          sortNo: 2,
          title: "第2课时",
          mainActivity: "活动2",
          observableProduct: "产出2",
          assessmentEvidence: "证据2",
          anticipatedDifficulties: [],
          plannedMinutes: 40,
          teacherNotes: "",
          status: "draft",
          version: 0,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
    );
    expect(hints.map((hint) => hint.feedbackId)).toEqual(["fb-pending"]);
  });

  it("builds a writeback seed that capability routing can parse", () => {
    const hint = buildContinuityWritebackHints(
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          notebookId: "n1",
          lessonFileId: "lf-1",
          lessonBlueprintId: "bp-1",
          semesterFrameworkId: "fw-1",
          kind: "continuity_outcome",
          statement: "通分过程不稳",
          relatedEntityId: null,
          continuityFingerprint: "fp-1",
          continuityDirection: "review",
          continuityOutcome: "weak",
          writebackStatus: "pending",
          evidence: {},
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
      [
        {
          id: "bp-1",
          frameworkId: "fw-1",
          semesterUnitId: "u1",
          curriculumNodeId: "ch1-1",
          chapterPeriodNo: 1,
          plannedPeriod: 1,
          sortNo: 1,
          title: "第1课时",
          mainActivity: "活动1",
          observableProduct: "产出1",
          assessmentEvidence: "证据1",
          anticipatedDifficulties: [],
          plannedMinutes: 40,
          teacherNotes: "",
          status: "taught",
          version: 1,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
        {
          id: "bp-2",
          frameworkId: "fw-1",
          semesterUnitId: "u1",
          curriculumNodeId: "ch1-1",
          chapterPeriodNo: 2,
          plannedPeriod: 2,
          sortNo: 2,
          title: "第2课时",
          mainActivity: "活动2",
          observableProduct: "产出2",
          assessmentEvidence: "证据2",
          anticipatedDifficulties: [],
          plannedMinutes: 40,
          teacherNotes: "",
          status: "draft",
          version: 0,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
    )[0];
    expect(hint).toBeTruthy();
    const seed = buildContinuityWritebackSeed(hint!);
    expect(seed).toContain("【衔接回写】");
    expect(seed).toContain("feedbackId:11111111-1111-4111-8111-111111111111");
    expect(parseContinuityWritebackFeedbackId(seed)).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("only resolves pending writeback feedback on the same framework", () => {
    const records = [
      {
        id: "fb-1",
        semesterFrameworkId: "fw-1",
        writebackStatus: "pending" as const,
      },
      {
        id: "fb-2",
        semesterFrameworkId: "fw-2",
        writebackStatus: "pending" as const,
      },
      {
        id: "fb-3",
        semesterFrameworkId: "fw-1",
        writebackStatus: "applied" as const,
      },
    ];
    expect(resolveScopedWritebackFeedbackId("fb-1", records, "fw-1")).toBe("fb-1");
    expect(resolveScopedWritebackFeedbackId("fb-2", records, "fw-1")).toBeUndefined();
    expect(resolveScopedWritebackFeedbackId("fb-3", records, "fw-1")).toBeUndefined();
  });
});
