import type {
  AgentRunEvidenceKind,
  AgentRunEvidenceRecord,
  CapabilityPlan,
} from "../domain.js";

const directlyObservedKinds = new Set<AgentRunEvidenceKind>([
  "knowledge_search",
  "curriculum_standard_search",
  "knowledge_passage",
  "attachment_read",
  "web_open",
  "curriculum_textbook",
  "curriculum_outline",
  "curriculum_semantics",
  "curriculum_knowledge",
]);

export function validateObservedEvidence(args: {
  plan: CapabilityPlan;
  evidence: AgentRunEvidenceRecord[];
}) {
  if (!args.plan.evidenceRequired) {
    return { tripwireTriggered: false, outputInfo: { code: "ok" } };
  }

  const observedKinds = new Set(
    args.evidence
      .map((record) => record.kind)
      .filter((kind) => directlyObservedKinds.has(kind)),
  );
  const requiredKinds = args.plan.requiredEvidenceKinds ?? [];
  const missingKinds = requiredKinds.filter((kind) => !observedKinds.has(kind));
  const hasDirectEvidence = observedKinds.size > 0;

  return {
    tripwireTriggered: !hasDirectEvidence || missingKinds.length > 0,
    outputInfo: {
      code: !hasDirectEvidence || missingKinds.length > 0 ? "evidence_required" : "ok",
      missingKinds,
    },
  };
}
