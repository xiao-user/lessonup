import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { approvalOutcomeMessage, toLessonUpProviderMessages } from "./runtime-messages.js";

const reasoning = (text: string) => ({
  type: "thinking" as const,
  thinking: text,
  thinkingSignature: "reasoning_content",
});

const withReasoning = (message: ReturnType<typeof fauxAssistantMessage>, text: string) => ({
  ...message,
  content: [reasoning(text), ...message.content],
});

const blockTypes = (message: unknown) =>
  (Array.isArray((message as { content?: unknown }).content)
    ? (message as { content: Array<{ type: string }> }).content
    : []
  ).map((block) => block.type);

describe("Pi provider message conversion", () => {
  it("keeps reasoning out of the provider context while preserving the visible turn", () => {
    const answered = withReasoning(fauxAssistantMessage("这份教案的教学过程已经完整。"), "x".repeat(20_000));
    const called = withReasoning(
      fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      "y".repeat(20_000),
    );

    const converted = toLessonUpProviderMessages([answered, called]);

    expect(blockTypes(converted[0])).toEqual(["text"]);
    expect(blockTypes(converted[1])).toEqual(["toolCall"]);
    expect(JSON.stringify(converted)).not.toContain("reasoning_content");
    // Prompt size is what drives reasoning latency, so the saving is the point.
    expect(JSON.stringify(converted).length)
      .toBeLessThan(JSON.stringify([answered, called]).length / 2);
  });

  it("leaves the durable transcript untouched", () => {
    const message = withReasoning(fauxAssistantMessage("已读取教案。"), "推理内容");
    const durable = [message];

    toLessonUpProviderMessages(durable);

    expect(blockTypes(durable[0])).toEqual(["thinking", "text"]);
  });

  it("keeps a reasoning-only message intact so the protocol stays valid", () => {
    const empty = { ...fauxAssistantMessage("x"), content: [reasoning("只有推理")] };

    expect(blockTypes(toLessonUpProviderMessages([empty])[0])).toEqual(["thinking"]);
  });

  it("keeps reasoning that a protocol replays as a paired item", () => {
    // The Responses protocol serializes a reasoning item into the signature and
    // validates it against its function call, so this one must survive.
    const paired = {
      ...fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }),
      content: [
        {
          type: "thinking" as const,
          thinking: "推理内容",
          thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }),
        },
        ...fauxAssistantMessage(fauxToolCall("read_document", {}), { stopReason: "toolUse" }).content,
      ],
    };

    expect(blockTypes(toLessonUpProviderMessages([paired])[0])).toEqual(["thinking", "toolCall"]);
  });

  it("replaces a durable approval outcome with one server-authored instruction", () => {
    const converted = toLessonUpProviderMessages([approvalOutcomeMessage({
      approvalId: "approval-1",
      decision: "approved",
      action: "document_patch",
      summary: "补充教学过程的证据环节",
      resourceType: "lesson_file",
    })]);

    expect(converted).toHaveLength(1);
    expect(converted[0]!.role).toBe("user");
    expect(JSON.stringify(converted[0])).toContain("approved and applied");
    expect(JSON.stringify(converted[0])).not.toContain("approval-1");
  });

  it("passes user and tool-result messages through unchanged", () => {
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "请修改教学过程" }], timestamp: 1 },
      { role: "toolResult" as const, content: [{ type: "text" as const, text: "教案正文" }], timestamp: 2, toolCallId: "call-1", toolName: "read_document", isError: false },
    ];

    expect(toLessonUpProviderMessages(messages as never)).toEqual(messages);
  });

  it("drops unknown custom roles instead of forwarding them to the provider", () => {
    const converted = toLessonUpProviderMessages([
      { role: "user", content: [{ type: "text", text: "请修改教学过程" }], timestamp: 1 },
      { role: "notification", text: "内部提示", timestamp: 2 } as never,
      { role: "toolResult", content: [{ type: "text", text: "教案正文" }], timestamp: 3, toolCallId: "call-1", toolName: "read_document", isError: false },
    ]);

    expect(converted).toHaveLength(2);
    expect(converted.map((message) => message.role)).toEqual(["user", "toolResult"]);
    expect(JSON.stringify(converted)).not.toContain("内部提示");
  });
});
