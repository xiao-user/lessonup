import type { OutputGuardrail, TextOutput } from "@openai/agents";

import type {
  AgentRunEvidenceKind,
  AgentRunEvidenceRecord,
  CapabilityPlan,
  PreparationAgentContext,
} from "../domain.js";
import type { LessonRepository } from "../repository.js";

const directlyObservedKinds = new Set<AgentRunEvidenceKind>([
  "knowledge_search",
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

export function createLessonOutputGuardrails(
  repository: LessonRepository,
  plan: CapabilityPlan,
): OutputGuardrail<TextOutput, PreparationAgentContext>[] {
  // Output-guardrail tripwires halt the run. Teacher-facing language is enforced
  // by semantic tool results + manager instructions instead, so the model can
  // recover inside the turn rather than failing the teacher-visible conversation.
  return [{
    name: "observed-evidence-required",
    execute: async ({ context }) => validateObservedEvidence({
      plan,
      evidence: await repository.listRunEvidence(
        context.context.userId,
        context.context.runId,
      ),
    }),
  }];
}
