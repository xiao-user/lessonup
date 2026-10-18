import type { LessonRepository } from "../repository.js";
import type { EvidenceCard } from "./contracts.js";
import { isSyntheticObservation } from "../learning/observation-plan.js";

const normalize = (value: string) => value.replace(/\s+/g, "");

/** Internal references have the same provenance boundary for teachers and Pi. */
export async function validateInternalDecisionSources(
  repository: LessonRepository,
  scope: { ownerId: string; lessonFileId: string },
  cards: EvidenceCard[],
) {
  for (const card of cards) {
    if (card.source.uri.startsWith("lessonup://lesson-files/")) {
      const file = await repository.getLessonFile(scope.ownerId, scope.lessonFileId);
      if (!file || card.source.uri !== `lessonup://lesson-files/${file.id}`
        || card.source.version !== String(file.documentVersion)) throw new Error("decision_evidence_source_invalid");
      const originals = Object.values(file.document);
      if (!normalize(card.excerpt) || !originals.some((text) => normalize(text).includes(normalize(card.excerpt)))) {
        throw new Error("decision_evidence_excerpt_not_exact");
      }
      continue;
    }
    if (!card.source.uri.startsWith("lessonup://learning-evidence/")) continue;
    const id = card.source.uri.slice("lessonup://learning-evidence/".length);
    const evidence = await repository.getLearningEvidence(scope.ownerId, id);
    if (!evidence || evidence.lessonFileId !== scope.lessonFileId) throw new Error("decision_evidence_source_invalid");
    if (card.source.version !== String(evidence.documentVersion)) throw new Error("decision_evidence_source_invalid");
    const originals = [evidence.objective, evidence.task, evidence.criterion, evidence.learnerGroup,
      evidence.observation, evidence.sourceReference, evidence.conditions ?? ""];
    if (!normalize(card.excerpt) || !originals.some((text) => normalize(text).includes(normalize(card.excerpt)))) {
      throw new Error("decision_evidence_excerpt_not_exact");
    }
    if (isSyntheticObservation(evidence) && card.level !== "synthetic") {
      throw new Error("decision_synthetic_evidence_declared_real");
    }
  }
}
