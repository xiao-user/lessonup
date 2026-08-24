import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * A durable business outcome, not a synthetic user utterance. Pi retains it
 * in the transcript and the model sees a deliberately small, server-authored
 * representation through `convertToLlm`.
 */
export type ApprovalOutcomeMessage = {
  role: "approval_outcome";
  approvalId: string;
  decision: "approved" | "rejected";
  action: string;
  summary: string;
  resourceType: "lesson_file" | "semester_framework";
  timestamp: number;
};

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    approval_outcome: ApprovalOutcomeMessage;
  }
}

export function approvalOutcomeMessage(input: Omit<ApprovalOutcomeMessage, "role" | "timestamp">): ApprovalOutcomeMessage {
  return { role: "approval_outcome", timestamp: Date.now(), ...input };
}

export function toLessonUpProviderMessages(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message) => {
    if (message.role !== "approval_outcome") return [message as Message];
    const decision = message.decision === "approved" ? "approved and applied" : "rejected";
    return [{
      role: "user" as const,
      content: [{
        type: "text" as const,
        text: `[Server-authoritative approval outcome]\nAction: ${message.action}\nDecision: ${decision}\nSummary: ${message.summary}\nContinue from this outcome. Do not claim any additional write unless a tool result confirms it.`,
      }],
      timestamp: message.timestamp,
    }];
  });
}
