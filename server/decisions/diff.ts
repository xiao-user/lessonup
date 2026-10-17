import type { DecisionDiff, DecisionRecord } from "./contracts.js";

const stable = (value: unknown) => JSON.stringify(value ?? null);

/** Shows which judgment changed, not just which document field changed. */
export function diffDecisions(previous: DecisionRecord, next: DecisionRecord): DecisionDiff {
  const changed: string[] = [];
  const compare = (field: string, before: unknown, after: unknown) => {
    if (stable(before) !== stable(after)) changed.push(field);
  };

  const beforeEvidence = new Set(previous.evidenceCardIds);
  const afterEvidence = new Set(next.evidenceCardIds);
  const addedEvidence = [...afterEvidence].filter((id) => !beforeEvidence.has(id)).sort();
  const removedEvidence = [...beforeEvidence].filter((id) => !afterEvidence.has(id)).sort();
  if (addedEvidence.length || removedEvidence.length) changed.push("evidenceCardIds");

  compare("decisionType", previous.decisionType, next.decisionType);
  compare("question", previous.question, next.question);
  compare("options", previous.options, next.options);
  compare("chosenOptionId", previous.chosenOptionId, next.chosenOptionId);
  compare("rationale", previous.rationale, next.rationale);
  compare("counterevidence", previous.counterevidence, next.counterevidence);
  compare("assumptions", previous.assumptions, next.assumptions);
  compare("uncertainties", previous.uncertainties, next.uncertainties);
  compare("confidence", previous.confidence, next.confidence);
  compare("expectedSignal", previous.expectedSignal, next.expectedSignal);
  compare("falsifier", previous.falsifier, next.falsifier);
  compare("reviewAt", previous.reviewAt, next.reviewAt);
  compare("status", previous.status, next.status);

  return {
    changed,
    addedEvidence,
    removedEvidence,
    confidenceDelta: previous.confidence !== null && next.confidence !== null
      ? Math.round((next.confidence - previous.confidence) * 100) / 100
      : null,
    statusFrom: previous.status,
    statusTo: next.status,
  };
}
