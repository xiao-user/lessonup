import type { AgentTaskIntent, CapabilityPlan } from "../domain.js";

/** Structured product actions take precedence over heuristic language routing. */
export function applyTaskIntent(plan: CapabilityPlan, taskIntent?: AgentTaskIntent): CapabilityPlan {
  if (!taskIntent) return plan;
  return {
    ...plan, taskIntent, executionLane: "agent", lightweightConversation: false,
    presentationRequested: false, skillIds: [], toolGroups: ["document-read", "document-write"],
    writeMode: taskIntent.type === "document_write" ? "explicit" : "consultative",
    requestedDocumentFields: taskIntent.type === "document_write" ? taskIntent.fields : undefined,
  };
}
