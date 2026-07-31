import { describe, expect, it } from "vitest";

import { toolOutputSucceeded } from "./harness.js";

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
});
