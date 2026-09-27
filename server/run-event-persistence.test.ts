import { describe, expect, it } from "vitest";
import { shouldPersistRunEvent } from "./run-event-persistence.js";

describe("shouldPersistRunEvent", () => {
  it("keeps recoverable activity but not transient stream deltas", () => {
    expect(shouldPersistRunEvent({ type: "message.delta", runId: "run", delta: "字" })).toBe(false);
    expect(shouldPersistRunEvent({
      type: "run.started",
      runId: "run",
      threadId: "thread",
      branchId: "branch",
    })).toBe(false);
    expect(shouldPersistRunEvent({ type: "agent.started", runId: "run" })).toBe(false);
    expect(shouldPersistRunEvent({ type: "turn.started", runId: "run", turn: 1 })).toBe(false);
    expect(shouldPersistRunEvent({
      type: "assistant.message.started",
      runId: "run",
      turn: 1,
    })).toBe(false);
    expect(shouldPersistRunEvent({
      type: "tool.updated",
      runId: "run",
      toolCallId: "tool",
      name: "read_document",
      label: "读取教案",
    })).toBe(true);
    expect(shouldPersistRunEvent({
      type: "tool.started",
      runId: "run",
      toolCallId: "tool",
      name: "read_lesson_section",
      label: "读取教学目标",
    })).toBe(true);
    expect(shouldPersistRunEvent({ type: "run.completed", runId: "run" })).toBe(true);
    expect(shouldPersistRunEvent({
      type: "message.turn_text",
      runId: "run",
      turn: 2,
      text: "已读取教案。",
    })).toBe(true);
  });
});
