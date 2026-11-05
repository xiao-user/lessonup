import {
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { PlatformSkill } from "../../agent/skill-registry.js";
import { encodePiAgentMessages } from "./message-codec.js";
import type { PiTransportTiming } from "./transport-timing.js";

export type PiRunScope = {
  ownerId: string;
  threadId: string;
  branchId: string;
};

/** Bounded server-authored recovery when an explicit task lacks its artifact. */
export type PiRequiredCompletion = {
  isComplete: () => boolean;
  followUp: string;
  maxFollowUps?: number;
};

export type PiAgentRunResult = {
  content: string;
  sessionCursor: number;
  sessionRevision: number;
  skillVersions: Record<string, string>;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    /** Durable evaluator aliases; retain the provider-shaped fields above. */
    requests: number;
    inputTokens: number;
    cachedInputTokens: number;
  };
  transportTiming: PiTransportTiming;
};

export function assistantText(messages: AgentMessage[]) {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant") return "";
  return assistant.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

const providerProtocolPattern = /(?:<\s*[｜|]{0,2}\s*DSML|<\s*\/?\s*(?:tool_calls?|invoke|parameter)\b|\[\s*TOOL_CALLS?\s*\])/iu;

function containsProviderProtocolText(messages: AgentMessage[]) {
  return messages.some((message) => message.role === "assistant" && message.content.some((block) => (
    block.type === "text" && providerProtocolPattern.test(block.text)
  )));
}

export function isSettledTranscriptTail(messages: AgentMessage[], minimumLength: number) {
  if (messages.length <= minimumLength) return true;
  const tail = messages.at(-1);
  if (!tail || tail.role === "user") return false;
  if (
    tail.role === "assistant"
    && ["pending", "error", "aborted"].includes(tail.stopReason)
  ) return false;
  return !containsProviderProtocolText(messages.slice(minimumLength));
}

export function largestSettledProtocolSafePrefix(messages: AgentMessage[], minimumLength: number) {
  for (let end = messages.length; end >= minimumLength; end -= 1) {
    try {
      const candidate = messages.slice(0, end);
      encodePiAgentMessages(candidate);
      if (isSettledTranscriptTail(candidate, minimumLength)) return candidate;
    } catch {
      // Keep trimming only the incomplete tail; stable prior protocol units stay.
    }
  }
  return messages.slice(0, minimumLength);
}

/**
 * Protocol snapshot that can be written mid-run. Complete tool groups stay;
 * an accepted user message is durable even before the assistant answers, and
 * even if the current assistant turn is still an incomplete tool unit.
 */
export function durableProtocolSnapshot(messages: AgentMessage[]) {
  const settled = largestSettledProtocolSafePrefix(messages, 0);
  if (messages.at(-1)?.role === "user") {
    try {
      encodePiAgentMessages(messages);
      return messages;
    } catch {
      return settled;
    }
  }
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (lastUserIndex >= settled.length) {
    const withUser = messages.slice(0, lastUserIndex + 1);
    try {
      encodePiAgentMessages(withUser);
      return withUser;
    } catch {
      return settled;
    }
  }
  return settled;
}

export function repairDurableHistory(messages: AgentMessage[]) {
  let repaired = largestSettledProtocolSafePrefix(messages, 0);
  while (containsProviderProtocolText(repaired)) {
    const invalidIndex = repaired.findIndex((message) => (
      message.role === "assistant"
      && message.content.some((block) => block.type === "text" && providerProtocolPattern.test(block.text))
    ));
    if (invalidIndex < 0) break;
    let turnStart = invalidIndex;
    while (turnStart > 0 && repaired[turnStart - 1]?.role !== "user") turnStart -= 1;
    if (turnStart > 0) turnStart -= 1;
    repaired = largestSettledProtocolSafePrefix(repaired.slice(0, turnStart), 0);
  }
  return repaired;
}

export function isApprovalRequiredToolResult(message: AgentMessage) {
  if (message.role !== "toolResult" || message.isError) return false;
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
  try {
    return JSON.parse(text).status === "approval_required";
  } catch {
    return false;
  }
}

function unmatchedApprovalRequiredIndexes(messages: AgentMessage[]) {
  const unmatched: number[] = [];
  messages.forEach((message, index) => {
    if (isApprovalRequiredToolResult(message)) {
      unmatched.push(index);
      return;
    }
    if (message.role === "approval_outcome" && unmatched.length > 0) unmatched.pop();
  });
  return unmatched;
}

/**
 * A protocol `approval_required` result is not a teacher-visible card.
 * Without a matching approval row the next turn must re-propose instead of
 * claiming the teacher already has a confirmation waiting. Resolved cards
 * stay: resume continues from that protocol result plus a new outcome
 * message. A later `approval_outcome` also consumes the nearest unmatched
 * proposal so a decided card is not rewritten into an error.
 */
export function rejectOrphanApprovalRequiredResults(
  messages: AgentMessage[],
  knownApprovalToolCallIds: ReadonlySet<string> = new Set(),
) {
  const orphanIndexes = new Set(
    unmatchedApprovalRequiredIndexes(messages).filter((index) => {
      const message = messages[index];
      return message?.role === "toolResult" && !knownApprovalToolCallIds.has(message.toolCallId);
    }),
  );
  if (orphanIndexes.size === 0) return messages;
  return messages.map((message, index) => {
    if (!orphanIndexes.has(index) || message.role !== "toolResult") return message;
    return {
      ...message,
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: "approval_not_persisted",
          message: "提案预检已通过，但教师确认卡未落盘。请再次调用同一写入工具提交提案，不要声称已在等待审批。",
        }),
      }],
    };
  });
}

export class PublicTextGuard {
  private buffer = "";
  private violated = false;

  push(delta: string) {
    if (this.violated) return "";
    this.buffer += delta;
    if (providerProtocolPattern.test(this.buffer)) {
      this.violated = true;
      this.buffer = "";
      return "";
    }
    // Only hold a suffix that could still become a provider-protocol marker
    // across chunk boundaries. The previous fixed 64-character delay made
    // every short answer appear non-streaming even when Pi emitted deltas
    // immediately.
    const possibleMarkerStart = Math.max(
      this.buffer.lastIndexOf("<"),
      this.buffer.lastIndexOf("["),
    );
    const markerTailLength = possibleMarkerStart < 0
      ? 0
      : this.buffer.length - possibleMarkerStart;
    const safeLength = possibleMarkerStart < 0 || markerTailLength > 64
      ? this.buffer.length
      : possibleMarkerStart;
    const safe = this.buffer.slice(0, safeLength);
    this.buffer = this.buffer.slice(safeLength);
    return safe;
  }

  flush() {
    if (this.violated) return "";
    const safe = this.buffer;
    this.buffer = "";
    return safe;
  }

  get hasViolation() {
    return this.violated;
  }
}

export function systemPromptWithSkills(base: string, skills: PlatformSkill[]) {
  if (!skills.length) return base;
  // The selected Skill is part of the cacheable system prefix. Inline it
  // immediately instead of spending one full provider round reading the same
  // pinned instructions before the first useful tool call.
  const instructions = skills.map((skill) => [
    `<skill id="${skill.id}" version="${skill.version}">`,
    `<name>${skill.id}</name>`,
    `<description>${skill.description}</description>`,
    skill.instructions,
    `</skill>`,
  ].join("\n")).join("\n");
  return [
    base,
    "",
    "本轮已选择下列钉定版本 Skill。直接按其完整说明执行。",
    "<active_skills>",
    instructions,
    "</active_skills>",
  ].join("\n");
}

export function assertSkillTools(skills: PlatformSkill[], tools: AgentTool<any>[]) {
  const names = new Set(tools.map((tool) => tool.name));
  for (const skill of skills) {
    for (const required of skill.requiredTools) {
      if (!names.has(required)) throw new Error(`pi_skill_required_tool_missing:${skill.id}:${required}`);
    }
  }
}
