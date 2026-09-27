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

/**
 * A reasoning signature is either a replayable protocol item or just the name
 * of the field the prose arrived in. The Responses protocol pairs reasoning
 * items with their function calls and validates that pairing, so those items
 * have to survive; a bare field name carries no such obligation.
 */
function isReplayableReasoning(block: { thinkingSignature?: string }) {
  if (!block.thinkingSignature) return false;
  try {
    const signature: unknown = JSON.parse(block.thinkingSignature);
    return typeof signature === "object" && signature !== null;
  } catch {
    return false;
  }
}

/**
 * Reasoning is produced per turn and is not context a later turn needs: the
 * model re-reasons from the visible transcript. Echoing it back re-sends every
 * earlier thought on every request, and prompt size is what drives reasoning
 * latency, so the cost compounds turn after turn. The durable transcript keeps
 * the raw blocks; only this provider-bound view drops them. A message left
 * with no content at all keeps its reasoning so the protocol stays valid.
 */
function withoutReasoning(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant") return message;
  const content = message.content.filter(
    (block) => block.type !== "thinking" || isReplayableReasoning(block),
  );
  if (content.length === message.content.length || content.length === 0) return message;
  return { ...message, content };
}

export function toLessonUpProviderMessages(messages: AgentMessage[]): Message[] {
  return messages.flatMap((value) => {
    const message = withoutReasoning(value);
    if (message.role === "approval_outcome") {
      const decision = message.decision === "approved" ? "approved and applied" : "rejected";
      return [{
        role: "user" as const,
        content: [{
          type: "text" as const,
          text: `[Server-authoritative approval outcome]\nAction: ${message.action}\nDecision: ${decision}\nSummary: ${message.summary}\nContinue from this outcome. Do not claim any additional write unless a tool result confirms it.`,
        }],
        timestamp: message.timestamp,
      }];
    }
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      return [message];
    }
    return [];
  });
}
