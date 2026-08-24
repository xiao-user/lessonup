import {
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { PlatformSkill } from "../../agent/skill-registry.js";
import { encodePiAgentMessages } from "./message-codec.js";

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
  };
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
  return [
    base,
    ...skills.map((skill) => [
      `\n\n<skill id="${skill.id}" version="${skill.version}">`,
      skill.instructions,
      "</skill>",
    ].join("\n")),
  ].join("");
}

export function assertSkillTools(skills: PlatformSkill[], tools: AgentTool<any>[]) {
  const names = new Set(tools.map((tool) => tool.name));
  for (const skill of skills) {
    for (const required of skill.requiredTools) {
      if (!names.has(required)) throw new Error(`pi_skill_required_tool_missing:${skill.id}:${required}`);
    }
  }
}
