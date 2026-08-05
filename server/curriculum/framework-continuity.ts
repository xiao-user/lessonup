import { createHash } from "node:crypto";
import type {
  CurriculumSemanticRelation,
  FrameworkContinuityCandidateRecord,
} from "../domain.js";

export type FrameworkUnitPointOccurrence = {
  unitId: string;
  unitSortNo: number;
  nodeId: string;
  sequenceNo: number;
  entityId: string;
  pointName: string;
  confidence: number;
};

export type ReviewedProgressionRelation = {
  id: string;
  relationType: Extract<
    CurriculumSemanticRelation,
    "prerequisite" | "supports" | "develops_into" | "transfers_to"
  >;
  fromEntityId: string;
  toEntityId: string;
  confidence: number;
  rationale: string;
};

export type FrameworkContinuityDraft = Omit<
  FrameworkContinuityCandidateRecord,
  "id" | "frameworkId" | "derivedFromFrameworkVersion" | "decision"
    | "active" | "createdAt" | "updatedAt"
> & { fingerprint: string };

const genericInstructionPhrases = [
  "基本特征",
  "具体表达效果",
  "表达效果",
  "具体意义",
  "主要内容",
  "故事",
  "语境",
  "词语",
  "理解",
  "分析",
  "识别",
  "掌握",
  "借助",
  "根据",
  "利用",
  "中的",
  "及其",
  "的",
  "与",
];

const genericOverlapBigrams = new Set([
  "内容",
  "作用",
  "故事",
  "语境",
  "词语",
  "意义",
  "特点",
  "方法",
  "关系",
  "结构",
  "活动",
]);

function lexicalKey(value: string) {
  let normalized = value.normalize("NFKC");
  for (const phrase of genericInstructionPhrases) {
    normalized = normalized.replaceAll(phrase, "");
  }
  return normalized.replace(/[\s，。、“”‘’；：！？《》（）()\-—]/g, "");
}

function ngrams(value: string, size: number) {
  const normalized = lexicalKey(value);
  const result = new Set<string>();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    result.add(normalized.slice(index, index + size));
  }
  return result;
}

function dice(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

export function continuityLexicalSimilarity(left: string, right: string) {
  const leftKey = lexicalKey(left);
  const rightKey = lexicalKey(right);
  if (leftKey.length < 2 || rightKey.length < 2) return 0;
  const leftBigrams = ngrams(leftKey, 2);
  const rightBigrams = ngrams(rightKey, 2);
  const hasMeaningfulOverlap = [...leftBigrams].some((item) => (
    rightBigrams.has(item) && !genericOverlapBigrams.has(item)
  ));
  if (!hasMeaningfulOverlap) return 0;
  return Math.max(
    dice(leftBigrams, rightBigrams),
    dice(ngrams(leftKey, 3), ngrams(rightKey, 3)),
  );
}

function fingerprint(value: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function candidate(args: Omit<FrameworkContinuityDraft, "fingerprint">) {
  return {
    ...args,
    fingerprint: fingerprint({
      targetUnitId: args.targetUnitId,
      direction: args.direction,
      currentEntityId: args.currentEntityId,
      relatedEntityId: args.relatedEntityId,
      relatedUnitId: args.relatedUnitId,
      evidenceKind: args.evidenceKind,
      relationId: args.relationId,
    }),
  };
}

export function deriveFrameworkContinuity(args: {
  occurrences: FrameworkUnitPointOccurrence[];
  relations: ReviewedProgressionRelation[];
  includeLexicalCandidates?: boolean;
}): FrameworkContinuityDraft[] {
  const drafts = new Map<string, FrameworkContinuityDraft>();
  const occurrencesByEntity = new Map<string, FrameworkUnitPointOccurrence[]>();
  for (const occurrence of args.occurrences) {
    const grouped = occurrencesByEntity.get(occurrence.entityId) ?? [];
    grouped.push(occurrence);
    occurrencesByEntity.set(occurrence.entityId, grouped);
  }

  for (const occurrences of occurrencesByEntity.values()) {
    for (const current of occurrences) {
      for (const related of occurrences) {
        if (current.unitId === related.unitId) continue;
        const direction = related.unitSortNo < current.unitSortNo ? "review" : "prepare";
        const draft = candidate({
          targetUnitId: current.unitId,
          direction,
          currentEntityId: current.entityId,
          currentPointName: current.pointName,
          relatedEntityId: related.entityId,
          relatedPointName: related.pointName,
          relatedUnitId: related.unitId,
          evidenceKind: "same_knowledge_point",
          relationId: null,
          relationType: null,
          confidence: Math.min(current.confidence, related.confidence),
          rationale: direction === "review"
            ? `同一已审核知识点“${current.pointName}”已在前序单元出现；是否复习仍需结合当前学情。`
            : `同一已审核知识点“${current.pointName}”会在后续单元再次出现；可在本单元设计必要铺垫。`,
          evidence: {
            currentNodeId: current.nodeId,
            currentSequenceNo: current.sequenceNo,
            relatedNodeId: related.nodeId,
            relatedSequenceNo: related.sequenceNo,
          },
        });
        drafts.set(draft.fingerprint, draft);
      }
    }
  }

  for (const relation of args.relations) {
    const fromOccurrences = occurrencesByEntity.get(relation.fromEntityId) ?? [];
    const toOccurrences = occurrencesByEntity.get(relation.toEntityId) ?? [];
    for (const from of fromOccurrences) {
      for (const to of toOccurrences) {
        // A reviewed directional edge only becomes an instructional continuity
        // candidate when its observed textbook order agrees with that direction.
        if (from.unitSortNo >= to.unitSortNo) continue;
        const shared = {
          evidenceKind: "approved_relation" as const,
          relationId: relation.id,
          relationType: relation.relationType,
          confidence: Math.min(from.confidence, to.confidence, relation.confidence),
          evidence: {
            fromNodeId: from.nodeId,
            fromSequenceNo: from.sequenceNo,
            toNodeId: to.nodeId,
            toSequenceNo: to.sequenceNo,
            relationRationale: relation.rationale,
          },
        };
        const review = candidate({
          ...shared,
          targetUnitId: to.unitId,
          direction: "review",
          currentEntityId: to.entityId,
          currentPointName: to.pointName,
          relatedEntityId: from.entityId,
          relatedPointName: from.pointName,
          relatedUnitId: from.unitId,
          rationale: `已审核关系表明“${from.pointName}”${relation.rationale || "支持"}“${to.pointName}”；它位于前序单元，是复习候选。`,
        });
        const prepare = candidate({
          ...shared,
          targetUnitId: from.unitId,
          direction: "prepare",
          currentEntityId: from.entityId,
          currentPointName: from.pointName,
          relatedEntityId: to.entityId,
          relatedPointName: to.pointName,
          relatedUnitId: to.unitId,
          rationale: `已审核关系表明“${from.pointName}”${relation.rationale || "支持"}“${to.pointName}”；后者位于后续单元，是铺垫候选。`,
        });
        drafts.set(review.fingerprint, review);
        drafts.set(prepare.fingerprint, prepare);
      }
    }
  }

  if (args.includeLexicalCandidates !== false) {
    for (const current of args.occurrences) {
      for (const related of args.occurrences) {
        if (
          current.unitId === related.unitId
          || current.entityId === related.entityId
        ) continue;
        const similarity = continuityLexicalSimilarity(
          current.pointName,
          related.pointName,
        );
        if (similarity < 0.3) continue;
        const direction = related.unitSortNo < current.unitSortNo ? "review" : "prepare";
        const draft = candidate({
          targetUnitId: current.unitId,
          direction,
          currentEntityId: current.entityId,
          currentPointName: current.pointName,
          relatedEntityId: related.entityId,
          relatedPointName: related.pointName,
          relatedUnitId: related.unitId,
          evidenceKind: "lexical_similarity",
          relationId: null,
          relationType: null,
          confidence: Math.min(current.confidence, related.confidence) * similarity,
          rationale: direction === "review"
            ? `“${current.pointName}”与前序“${related.pointName}”在教材知识点表述上高度相关；它是待判断的复习候选，不代表已确认先修关系。`
            : `“${current.pointName}”与后序“${related.pointName}”在教材知识点表述上高度相关；它是待判断的铺垫候选，不代表已确认先修关系。`,
          evidence: {
            algorithm: "normalized_name_ngram_v1",
            lexicalSimilarity: similarity,
            currentNodeId: current.nodeId,
            currentSequenceNo: current.sequenceNo,
            relatedNodeId: related.nodeId,
            relatedSequenceNo: related.sequenceNo,
          },
        });
        drafts.set(draft.fingerprint, draft);
      }
    }
  }

  const sorted = [...drafts.values()].sort((left, right) => (
    left.targetUnitId.localeCompare(right.targetUnitId)
    || left.direction.localeCompare(right.direction)
    || (left.evidenceKind === "lexical_similarity" ? 1 : 0)
      - (right.evidenceKind === "lexical_similarity" ? 1 : 0)
    || right.confidence - left.confidence
    || left.fingerprint.localeCompare(right.fingerprint)
  ));
  const lexicalCounts = new Map<string, number>();
  return sorted.filter((draft) => {
    if (draft.evidenceKind !== "lexical_similarity") return true;
    const key = `${draft.targetUnitId}:${draft.direction}`;
    const count = lexicalCounts.get(key) ?? 0;
    if (count >= 8) return false;
    lexicalCounts.set(key, count + 1);
    return true;
  });
}
