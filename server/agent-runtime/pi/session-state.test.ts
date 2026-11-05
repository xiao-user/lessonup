import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
  findPiCompactionCursor,
  piContextBudgetExceeded,
  piEffectiveContextBytes,
  piMemoryCompactionTriggerBytes,
  piMessagePayloadBytes,
  shouldCompactPiMemory,
  validatePiThreadMemory,
} from "./memory.js";
import {
  PublicTextGuard,
  durableProtocolSnapshot,
  rejectOrphanApprovalRequiredResults,
  repairDurableHistory,
  systemPromptWithSkills,
} from "./session-state.js";
import { approvalOutcomeMessage } from "./runtime-messages.js";

const userMessage = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: Date.now(),
});

const storedSummary = (summarizedThrough: number) => JSON.stringify({
  schemaVersion: 1,
  runtime: "pi",
  summarizedThrough,
  goals: ["修订教学过程"],
  durableFacts: [],
  decisions: [],
  resourceReferences: [],
  evidence: [],
  unresolved: [],
  rejectedOrSuperseded: [],
});

const toolResultPayload = (message: unknown) => {
  const content = message && typeof message === "object" && "content" in message
    ? (message as { content?: unknown }).content
    : undefined;
  const text = Array.isArray(content)
    ? content.find((block): block is { type: "text"; text: string } => (
      Boolean(block)
      && typeof block === "object"
      && "type" in block
      && (block as { type?: unknown }).type === "text"
      && "text" in block
      && typeof (block as { text?: unknown }).text === "string"
    ))?.text ?? "{}"
    : "{}";
  return JSON.parse(text) as Record<string, unknown>;
};

describe("Pi native Agent session state", () => {
  it("drops an incomplete tool protocol tail but preserves the last settled turn", () => {
    const settled = [userMessage("第一轮"), fauxAssistantMessage("已完成第一轮")];
    const repaired = repairDurableHistory([
      ...settled,
      userMessage("第二轮"),
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
    ]);
    expect(repaired).toEqual(settled);
  });

  it("keeps an accepted user message durable before the assistant answers", () => {
    const history = [userMessage("第一轮"), fauxAssistantMessage("已完成第一轮")];
    const pending = [...history, userMessage("第二轮")];
    expect(durableProtocolSnapshot(pending)).toEqual(pending);
    expect(durableProtocolSnapshot([
      ...pending,
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
    ])).toEqual(pending);
  });

  it("never publishes provider tool protocol as assistant text", () => {
    const guard = new PublicTextGuard();
    expect(guard.push("准备调用 <tool_call>read_document")).toBe("");
    expect(guard.hasViolation).toBe(true);
    expect(guard.flush()).toBe("");
  });

  it("streams ordinary text immediately while retaining only a possible protocol marker", () => {
    const guard = new PublicTextGuard();
    expect(guard.push("正在分析当前教案。 ")).toBe("正在分析当前教案。 ");
    expect(guard.push("准备<tool_")).toBe("准备");
    expect(guard.push("call>read_document")).toBe("");
    expect(guard.hasViolation).toBe(true);
  });

  it("compacts only at a complete user-turn boundary and keeps more than the last two messages", () => {
    const messages = [
      userMessage("一"), fauxAssistantMessage("答一"),
      userMessage("二"), fauxAssistantMessage("答二"),
      userMessage("三"), fauxAssistantMessage("答三"),
    ];
    expect(findPiCompactionCursor(messages, 1)).toBe(4);
    expect(findPiCompactionCursor(messages, 3)).toBe(2);
    expect(findPiCompactionCursor(messages, 8_000)).toBeNull();
    const bulky = [
      userMessage("一"), fauxAssistantMessage("x".repeat(40_000)),
      userMessage("二"), fauxAssistantMessage("x".repeat(40_000)),
      userMessage("三"), fauxAssistantMessage("x".repeat(40_000)),
      userMessage("四"), fauxAssistantMessage("短"),
    ];
    expect(findPiCompactionCursor(bulky, 20_000)).toBe(2);
    expect(findPiCompactionCursor(bulky, 20_000)).toBeLessThan(bulky.length - 2);
  });

  it("does not choose a toolResult as the compaction cut", () => {
    const assistant = fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" });
    const toolCall = assistant.content.find((block) => block.type === "toolCall");
    const messages = [
      userMessage("第一轮"),
      assistant,
      {
        role: "toolResult" as const,
        toolCallId: toolCall && "id" in toolCall ? toolCall.id : "tool-1",
        toolName: "read_document",
        content: [{ type: "text" as const, text: "教案" }],
        isError: false,
        timestamp: Date.now(),
      },
      userMessage("第二轮"),
      fauxAssistantMessage("已完成"),
    ];
    const cursor = findPiCompactionCursor(messages, 1);
    expect(cursor).toBe(3);
    expect(messages[cursor!]?.role).toBe("user");
  });

  it("scales the compaction trigger with the model context window instead of a fixed byte count", () => {
    const transcript = [
      userMessage("第一轮"), fauxAssistantMessage("完成"),
      userMessage("第二轮"), fauxAssistantMessage("完成"),
      userMessage("第三轮"), fauxAssistantMessage("x".repeat(20_000)),
      userMessage("第四轮"), fauxAssistantMessage("完成"),
    ];
    const bytes = piMessagePayloadBytes(transcript);
    expect(bytes).toBeGreaterThan(20_000);

    // A transcript this size is noise against a large window. Summarizing it
    // would spend a full model call for nothing on nearly every turn.
    expect(piMemoryCompactionTriggerBytes(200_000)).toBeGreaterThan(bytes);
    expect(shouldCompactPiMemory(transcript, 200_000)).toBe(false);

    // The same transcript genuinely crowds a small window.
    expect(shouldCompactPiMemory(transcript, 4_000)).toBe(true);

    // The last completed user/assistant turn remains protocol-safe raw context.
    expect(findPiCompactionCursor(transcript, 2)).toBe(6);
  });

  it("inlines the selected pinned Skill to avoid a separate instruction-read round", () => {
    const prompt = systemPromptWithSkills("base", [{
      id: "classroom-direction",
      version: "1.2.3",
      description: "课堂编导",
      instructions: "按学习过程组织课堂材料。",
      requiredTools: [],
      requiredMcp: [],
    }]);
    expect(prompt).toContain("<active_skills>");
    expect(prompt).toContain("<name>classroom-direction</name>");
    expect(prompt).toContain("1.2.3");
    expect(prompt).toContain("按学习过程组织课堂材料。");
    expect(prompt).not.toContain("read_skill");
  });

  it("separates a transcript worth summarizing from one that cannot be sent without a summary", () => {
    const transcript = [
      userMessage("第一轮"), fauxAssistantMessage("完成"),
      userMessage("第二轮"), fauxAssistantMessage("x".repeat(20_000)),
    ];

    // Between the two thresholds compaction is worthwhile but never required,
    // so no teacher-visible turn may wait for it.
    expect(shouldCompactPiMemory(transcript, 10_000)).toBe(true);
    expect(piContextBudgetExceeded(transcript, undefined, 10_000)).toBe(false);

    // Only a transcript that no longer fits makes the summary a precondition.
    expect(piContextBudgetExceeded(transcript, undefined, 4_000)).toBe(true);
    expect(piContextBudgetExceeded(transcript, undefined, 200_000)).toBe(false);
  });

  it("counts only the messages a committed summary leaves in the prompt", () => {
    const transcript = [
      userMessage("第一轮"), fauxAssistantMessage("x".repeat(20_000)),
      userMessage("第二轮"), fauxAssistantMessage("完成"),
    ];
    const memory = validatePiThreadMemory({ summary: storedSummary(2), cursor: 2 }, transcript.length);
    expect(memory).toBeDefined();
    expect(piEffectiveContextBytes(transcript, memory!.summary))
      .toBeLessThan(piEffectiveContextBytes(transcript));
  });

  it("ignores a persisted summary that no longer matches the durable transcript", () => {
    expect(validatePiThreadMemory({ summary: storedSummary(4), cursor: 4 }, 6)?.cursor).toBe(4);
    // A cursor ahead of the transcript, a cursor that contradicts the summary,
    // and malformed content all fall back to canonical raw history.
    expect(validatePiThreadMemory({ summary: storedSummary(4), cursor: 4 }, 2)).toBeUndefined();
    expect(validatePiThreadMemory({ summary: storedSummary(4), cursor: 5 }, 6)).toBeUndefined();
    expect(validatePiThreadMemory({ summary: "not-json", cursor: 4 }, 6)).toBeUndefined();
    expect(validatePiThreadMemory(undefined, 6)).toBeUndefined();
  });

  it("rewrites an unmatched approval_required result so the next turn cannot claim a missing card", () => {
    const assistant = fauxAssistantMessage(fauxToolCall("propose_document_patch", {}), { stopReason: "toolUse" });
    const toolCall = assistant.content.find((block) => block.type === "toolCall");
    const toolCallId = toolCall && "id" in toolCall ? toolCall.id : "tool-1";
    const history = [
      userMessage("请修改评价"),
      assistant,
      {
        role: "toolResult" as const,
        toolCallId,
        toolName: "propose_document_patch",
        isError: false,
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "approval_required", summary: "改评价" }),
        }],
        timestamp: Date.now(),
      },
    ];
    const repaired = rejectOrphanApprovalRequiredResults(history);
    expect(toolResultPayload(repaired[2])).toMatchObject({ error: "approval_not_persisted" });
    expect(rejectOrphanApprovalRequiredResults(history, new Set([toolCallId]))).toBe(history);
  });

  it("keeps a decided proposal and only rewrites an earlier unmatched ghost", () => {
    const ghost = fauxAssistantMessage(fauxToolCall("propose_document_patch", { summary: "ghost" }), { stopReason: "toolUse" });
    const real = fauxAssistantMessage(fauxToolCall("propose_document_patch", { summary: "real" }), { stopReason: "toolUse" });
    const ghostCall = ghost.content.find((block) => block.type === "toolCall");
    const realCall = real.content.find((block) => block.type === "toolCall");
    const ghostId = ghostCall && "id" in ghostCall ? ghostCall.id : "ghost";
    const realId = realCall && "id" in realCall ? realCall.id : "real";
    const history = [
      userMessage("第一次"),
      ghost,
      {
        role: "toolResult" as const,
        toolCallId: ghostId,
        toolName: "propose_document_patch",
        isError: false,
        content: [{ type: "text" as const, text: JSON.stringify({ status: "approval_required", summary: "ghost" }) }],
        timestamp: 1,
      },
      userMessage("第二次"),
      real,
      {
        role: "toolResult" as const,
        toolCallId: realId,
        toolName: "propose_document_patch",
        isError: false,
        content: [{ type: "text" as const, text: JSON.stringify({ status: "approval_required", summary: "real" }) }],
        timestamp: 2,
      },
      approvalOutcomeMessage({
        approvalId: "approval-1",
        decision: "approved",
        action: "apply_document_patch",
        summary: "已写入",
        resourceType: "lesson_file",
      }),
    ];
    const repaired = rejectOrphanApprovalRequiredResults(history);
    expect(toolResultPayload(repaired[2])).toMatchObject({ error: "approval_not_persisted" });
    expect(toolResultPayload(repaired[5])).toMatchObject({ status: "approval_required" });
  });
});
