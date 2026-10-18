import type { AgentTaskIntent, CapabilityPlan } from "../domain.js";

/** Structured product actions take precedence over heuristic language routing. */
export function applyTaskIntent(plan: CapabilityPlan, taskIntent?: AgentTaskIntent): CapabilityPlan {
  if (!taskIntent) return plan;
  const confirmedDecisionRevision = taskIntent.type === "document_write" && Boolean(taskIntent.decisionRef);
  return {
    ...plan, taskIntent, executionLane: "agent", lightweightConversation: false,
    // Preparation checks the reference against canonical ownership, version,
    // teacher confirmation and origin. This action implements that choice;
    // button wording must not add an external-source or one-operation gate.
    // Explicit field scope and the normal version/approval checks still apply.
    ...(confirmedDecisionRevision ? {
      evidenceRequired: false,
      requiredEvidenceKinds: undefined,
      mcpServers: [],
      minimalWriteRequested: false,
    } : {}),
    presentationRequested: false, skillIds: [], toolGroups: ["document-read", "document-write"],
    writeMode: taskIntent.type === "document_write" ? "explicit" : "consultative",
    requestedDocumentFields: taskIntent.type === "document_write" ? taskIntent.fields : undefined,
    curriculumRequested: taskIntent.type === "decision_proposal" ? true : plan.curriculumRequested,
  };
}
