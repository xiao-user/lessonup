import { describe, expect, it } from "vitest";

import { proposalRevisionCodeOf, toolOutputSucceeded } from "./harness.js";

describe("normalized tool completion state", () => {
  it("uses SDK-only custom data to expose an MCP tool failure truthfully", () => {
    expect(toolOutputSucceeded({
      type: "run_item_stream_event",
      name: "tool_output",
      item: {
        output: "可展示给模型的错误文本",
        customData: { isError: true },
      },
    } as any)).toBe(false);
  });

  it("does not infer success from an aborted tool output", () => {
    expect(toolOutputSucceeded({
      type: "run_item_stream_event",
      name: "tool_output",
      item: { output: "aborted" },
    } as any)).toBe(false);
  });

  it("marks a recoverable proposal rejection as unsuccessful activity", () => {
    expect(toolOutputSucceeded({
      type: "run_item_stream_event",
      name: "tool_output",
      item: {
        output: "【提案需调整】删除无效操作",
      },
    } as any)).toBe(false);
  });

  it("persists a safe business reason without exposing rejected tool arguments", () => {
    expect(proposalRevisionCodeOf(
      "【提案需调整】教案快照已经变化。请重新读取实际目标栏目和文档版本。",
    )).toBe("document_context_stale");
  });
});
