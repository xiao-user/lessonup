import { describe, expect, it } from "vitest";
import { shouldPersistRunEvent } from "./run-event-persistence.js";

describe("shouldPersistRunEvent", () => {
  it("keeps recoverable activity but not transient stream deltas", () => {
    expect(shouldPersistRunEvent({ type: "message.delta", runId: "run", delta: "字" })).toBe(false);
    expect(shouldPersistRunEvent({
      type: "tool.started",
      runId: "run",
      toolCallId: "tool",
      name: "read_lesson_section",
      label: "读取教学目标",
    })).toBe(true);
    expect(shouldPersistRunEvent({ type: "run.completed", runId: "run" })).toBe(true);
  });
});
