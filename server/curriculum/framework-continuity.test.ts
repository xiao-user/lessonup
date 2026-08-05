import { describe, expect, it } from "vitest";
import { deriveFrameworkContinuity } from "./framework-continuity.js";

describe("deterministic framework continuity", () => {
  it("derives review and preparation candidates from the same reviewed point", () => {
    const candidates = deriveFrameworkContinuity({
      occurrences: [{
        unitId: "unit-1", unitSortNo: 1, nodeId: "node-1", sequenceNo: 2,
        entityId: "point-a", pointName: "朗读节奏", confidence: 0.9,
      }, {
        unitId: "unit-2", unitSortNo: 2, nodeId: "node-2", sequenceNo: 10,
        entityId: "point-a", pointName: "朗读节奏", confidence: 0.8,
      }],
      relations: [],
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetUnitId: "unit-1",
        relatedUnitId: "unit-2",
        direction: "prepare",
        evidenceKind: "same_knowledge_point",
        confidence: 0.8,
      }),
      expect.objectContaining({
        targetUnitId: "unit-2",
        relatedUnitId: "unit-1",
        direction: "review",
        evidenceKind: "same_knowledge_point",
      }),
    ]));
  });

  it("uses only reviewed directional relations whose order agrees with the textbook", () => {
    const occurrences = [{
      unitId: "unit-1", unitSortNo: 1, nodeId: "node-1", sequenceNo: 2,
      entityId: "point-a", pointName: "直接描写", confidence: 0.95,
    }, {
      unitId: "unit-2", unitSortNo: 2, nodeId: "node-2", sequenceNo: 9,
      entityId: "point-b", pointName: "人物形象分析", confidence: 0.9,
    }];
    const candidates = deriveFrameworkContinuity({
      occurrences,
      relations: [{
        id: "relation-1",
        relationType: "supports",
        fromEntityId: "point-a",
        toEntityId: "point-b",
        confidence: 0.85,
        rationale: "为提取人物特征提供文本证据",
      }, {
        id: "relation-reversed",
        relationType: "prerequisite",
        fromEntityId: "point-b",
        toEntityId: "point-a",
        confidence: 1,
        rationale: "与教材顺序冲突",
      }],
    });

    expect(candidates.filter((item) => item.evidenceKind === "approved_relation")).toHaveLength(2);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetUnitId: "unit-1", direction: "prepare" }),
      expect.objectContaining({ targetUnitId: "unit-2", direction: "review" }),
    ]));
    expect(candidates.some((item) => item.relationId === "relation-reversed")).toBe(false);
  });

  it("recalls explainable lexical candidates without presenting them as verified relations", () => {
    const candidates = deriveFrameworkContinuity({
      occurrences: [{
        unitId: "unit-1", unitSortNo: 1, nodeId: "node-1", sequenceNo: 3,
        entityId: "point-observe", pointName: "有目的的细致观察", confidence: 1,
      }, {
        unitId: "unit-5", unitSortNo: 5, nodeId: "node-5", sequenceNo: 38,
        entityId: "point-animal-observe", pointName: "动物形态与行为的细致观察", confidence: 1,
      }, {
        unitId: "unit-2", unitSortNo: 2, nodeId: "node-2", sequenceNo: 12,
        entityId: "point-prose", pointName: "散文诗的基本特征", confidence: 1,
      }, {
        unitId: "unit-6", unitSortNo: 6, nodeId: "node-6", sequenceNo: 45,
        entityId: "point-myth", pointName: "神话的产生和基本特征", confidence: 1,
      }, {
        unitId: "unit-2", unitSortNo: 2, nodeId: "node-story", sequenceNo: 15,
        entityId: "point-story-read", pointName: "借助注释理解并复述文言故事", confidence: 1,
      }, {
        unitId: "unit-6", unitSortNo: 6, nodeId: "node-fable", sequenceNo: 48,
        entityId: "point-fable", pointName: "寓言的故事与寓意", confidence: 1,
      }],
      relations: [],
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetUnitId: "unit-1",
        relatedUnitId: "unit-5",
        direction: "prepare",
        evidenceKind: "lexical_similarity",
        relationId: null,
      }),
      expect.objectContaining({
        targetUnitId: "unit-5",
        relatedUnitId: "unit-1",
        direction: "review",
        evidenceKind: "lexical_similarity",
      }),
    ]));
    expect(candidates.some((candidate) => (
      candidate.currentEntityId === "point-prose"
      && candidate.relatedEntityId === "point-myth"
    ))).toBe(false);
    expect(candidates.some((candidate) => (
      candidate.currentEntityId === "point-story-read"
      && candidate.relatedEntityId === "point-fable"
    ))).toBe(false);
  });
});
