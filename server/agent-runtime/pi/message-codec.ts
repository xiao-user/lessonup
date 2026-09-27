import type { AgentMessage } from "@earendil-works/pi-agent-core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertContentBlocks(value: unknown, allowed: Set<string>) {
  if (!Array.isArray(value)) throw new Error("pi_session_message_content_invalid");
  for (const block of value) {
    if (!isRecord(block) || typeof block.type !== "string" || !allowed.has(block.type)) {
      throw new Error("pi_session_message_content_invalid");
    }
    if (block.type === "text" && typeof block.text !== "string") {
      throw new Error("pi_session_message_content_invalid");
    }
    if (block.type === "thinking" && typeof block.thinking !== "string") {
      throw new Error("pi_session_message_content_invalid");
    }
    if (block.type === "image" && (typeof block.data !== "string" || typeof block.mimeType !== "string")) {
      throw new Error("pi_session_message_content_invalid");
    }
    if (
      block.type === "toolCall"
      && (typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.arguments))
    ) {
      throw new Error("pi_session_message_content_invalid");
    }
  }
}

/**
 * Treat persisted transcripts as untrusted JSON. Besides validating individual
 * messages, this preserves complete assistant tool-call/result protocol units.
 */
export function decodePiAgentMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) throw new Error("pi_session_messages_invalid");
  const pendingToolCalls = new Map<string, string>();
  for (const message of value) {
    if (!isRecord(message) || typeof message.role !== "string" || typeof message.timestamp !== "number") {
      throw new Error("pi_session_message_invalid");
    }
    if (message.role === "user") {
      if (typeof message.content !== "string") {
        assertContentBlocks(message.content, new Set(["text", "image"]));
      }
      continue;
    }
    if (message.role === "assistant") {
      if (
        typeof message.api !== "string"
        || typeof message.provider !== "string"
        || typeof message.model !== "string"
        || typeof message.stopReason !== "string"
        || !isRecord(message.usage)
      ) {
        throw new Error("pi_session_assistant_invalid");
      }
      assertContentBlocks(message.content, new Set(["text", "thinking", "toolCall"]));
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type !== "toolCall") continue;
        if (pendingToolCalls.has(block.id as string)) throw new Error("pi_session_tool_call_duplicate");
        pendingToolCalls.set(block.id as string, block.name as string);
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (
        typeof message.toolCallId !== "string"
        || typeof message.toolName !== "string"
        || typeof message.isError !== "boolean"
      ) {
        throw new Error("pi_session_tool_result_invalid");
      }
      assertContentBlocks(message.content, new Set(["text", "image"]));
      const expectedName = pendingToolCalls.get(message.toolCallId);
      if (!expectedName || expectedName !== message.toolName) {
        throw new Error("pi_session_tool_result_orphaned");
      }
      pendingToolCalls.delete(message.toolCallId);
      continue;
    }
    if (message.role === "approval_outcome") {
      if (
        typeof message.approvalId !== "string"
        || !["approved", "rejected"].includes(String(message.decision))
        || typeof message.action !== "string"
        || typeof message.summary !== "string"
        || !["lesson_file", "semester_framework"].includes(String(message.resourceType))
      ) {
        throw new Error("pi_session_approval_outcome_invalid");
      }
      continue;
    }
    throw new Error("pi_session_message_role_invalid");
  }
  if (pendingToolCalls.size) throw new Error("pi_session_tool_result_missing");
  return structuredClone(value) as AgentMessage[];
}

export function encodePiAgentMessages(messages: AgentMessage[]) {
  return decodePiAgentMessages(structuredClone(messages)) as unknown[];
}
