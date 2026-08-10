import { describe, expect, it } from "vitest";

import {
  continuityDraft,
  lessonPeriodContext,
  lessonPeriodLabel,
  nextLessonPeriodContext,
} from "./lesson-blueprint-context";

describe("lesson blueprint A4 context", () => {
  it("derives the current chapter period from same-chapter blueprints", () => {
    const first = { id: "first", curriculumNodeId: "spring", plannedPeriod: 4 };
    const second = { id: "second", curriculumNodeId: "spring", plannedPeriod: 5 };
    const context = lessonPeriodContext(
      second,
      [first, second, { id: "other", curriculumNodeId: "winter", plannedPeriod: 6 }],
      { periodRecommendations: [{ periodNo: 1 }, { periodNo: 2 }] },
    );
    expect(context).toMatchObject({ periodNo: 2, periodCount: 2, missingPeriods: 0 });
    expect(lessonPeriodLabel(context.periodNo, context.periodCount)).toBe("第 2 课时");
  });

  it("uses recommendations to expose missing chapter periods without treating minutes as a period count", () => {
    const context = lessonPeriodContext(
      { id: "first", curriculumNodeId: "spring", plannedMinutes: 120 },
      [{ id: "first", curriculumNodeId: "spring", plannedMinutes: 120 }],
      { periodRecommendations: [{ periodNo: 1 }, { periodNo: 2 }] },
    );
    expect(context).toMatchObject({ periodNo: 1, periodCount: 2, missingPeriods: 1 });
    expect(nextLessonPeriodContext("spring", [{ id: "first", curriculumNodeId: "spring" }], {
      periodRecommendations: [{ periodNo: 1 }, { periodNo: 2 }],
    })).toMatchObject({ periodNo: 2, periodCount: 2 });
  });

  it("uses the persisted chapter period identity and detects gaps", () => {
    const context = lessonPeriodContext(
      { id: "third", curriculumNodeId: "spring", chapterPeriodNo: 3 },
      [
        { id: "first", curriculumNodeId: "spring", chapterPeriodNo: 1 },
        { id: "third", curriculumNodeId: "spring", chapterPeriodNo: 3 },
      ],
      { periodRecommendations: [{ periodNo: 1 }, { periodNo: 2 }] },
    );
    expect(context).toMatchObject({ periodNo: 3, periodCount: 3, missingPeriods: 1 });
  });

  it("limits lesson knowledge to the current recommended period", () => {
    const context = lessonPeriodContext(
      { id: "second", curriculumNodeId: "spring" },
      [{ id: "first", curriculumNodeId: "spring" }, { id: "second", curriculumNodeId: "spring" }],
      { points: [
        { recommendedPeriod: 1, point: { canonicalName: "概括春景" } },
        { recommendedPeriod: 2, point: { canonicalName: "比喻与朗读" } },
      ], periodRecommendations: [{ periodNo: 1 }, { periodNo: 2, title: "第2课时" }] },
    );
    expect(context.points.map((item) => item.point.canonicalName)).toEqual(["比喻与朗读"]);
  });

  it("turns verified candidates into teacher-readable review and preparation notes", () => {
    expect(continuityDraft([
      { direction: "review", relatedPointName: "写景顺序", currentPointName: "篇章结构" },
      { direction: "prepare", relatedPointName: "景物片段写作", currentPointName: "拟人表达" },
    ])).toContain("复习旧知：写景顺序（用于衔接篇章结构）");
    expect(continuityDraft([
      { direction: "prepare", relatedPointName: "景物片段写作", currentPointName: "拟人表达" },
    ])).toContain("后续铺垫：拟人表达 → 景物片段写作");
  });

  it("prefers accepted continuity and omits dismissed candidates from drafts", () => {
    expect(continuityDraft([
      {
        direction: "review",
        decision: "dismissed",
        evidenceKind: "same_knowledge_point",
        relatedPointName: "应排除",
        currentPointName: "本课",
      },
      {
        direction: "review",
        decision: "accepted",
        evidenceKind: "lexical_similarity",
        relatedPointName: "应采用",
        currentPointName: "本课",
      },
      {
        direction: "review",
        decision: "candidate",
        evidenceKind: "same_knowledge_point",
        relatedPointName: "普通候选",
        currentPointName: "本课",
      },
    ])).toBe("复习旧知：应采用（用于衔接本课）");
  });
});
