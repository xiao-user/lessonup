import { describe, expect, it } from "vitest";

import {
  persistedActivitiesFromEvents,
  persistedTurnPhaseFromEvents,
} from "./agent-activity-presentation.js";

describe("persistedActivitiesFromEvents", () => {
  const started = {
    type: "tool.started" as const,
    runId: "run-1",
    toolCallId: "tool-1",
    name: "read_document",
    label: "读取整份教案",
  };

  it("restores a teacher-cancelled tool as stopped rather than failed or running", () => {
    expect(persistedActivitiesFromEvents([started], "cancelled")).toEqual([
      expect.objectContaining({ state: "cancelled", outcome: "cancelled" }),
    ]);
  });

  it("keeps completed and failed terminal states distinct", () => {
    expect(persistedActivitiesFromEvents([started], "completed")).toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
    expect(persistedActivitiesFromEvents([started], "failed")).toEqual([
      expect.objectContaining({ state: "failed" }),
    ]);
  });

  it("restores a safe activity detail for older persisted events", () => {
    expect(persistedActivitiesFromEvents([started], "completed")).toEqual([
      expect.objectContaining({
        detail: "读取当前教案的完整内容，作为后续分析与修改依据。",
      }),
    ]);
  });

  it("restores a terminal outcome summary when an older completion has no detail", () => {
    expect(persistedActivitiesFromEvents([
      started,
      {
        type: "tool.completed",
        runId: "run-1",
        toolCallId: "tool-1",
        name: "read_document",
        label: "读取整份教案",
        ok: true,
      },
    ], "completed")).toEqual([
      expect.objectContaining({
        detail: "读取整份教案已完成，Pi 将基于读取到的当前信息继续处理。",
      }),
    ]);
  });
});

describe("persistedTurnPhaseFromEvents", () => {
  it("restores the latest native Pi lifecycle phase without inventing progress", () => {
    expect(persistedTurnPhaseFromEvents([
      { type: "agent.started", runId: "run-1" },
      { type: "turn.started", runId: "run-1", turn: 1 },
      { type: "assistant.message.started", runId: "run-1", turn: 1 },
    ], "running")).toEqual({ phase: "responding", currentTurn: 1 });

    expect(persistedTurnPhaseFromEvents([
      { type: "agent.started", runId: "run-1" },
      { type: "turn.started", runId: "run-1", turn: 1 },
      { type: "tool.started", runId: "run-1", toolCallId: "tool-1", name: "read_document", label: "读取整份教案" },
    ], "running")).toEqual({ phase: "using_tools", currentTurn: 1 });
  });

  it("does not leave a lifecycle focus on a terminal run", () => {
    expect(persistedTurnPhaseFromEvents([
      { type: "agent.ended", runId: "run-1", turnCount: 1, outcome: "failed" },
    ], "failed")).toBeUndefined();
  });

  it("does not invent an organizing phase after a completed tool", () => {
    expect(persistedTurnPhaseFromEvents([
      { type: "agent.started", runId: "run-1" },
      { type: "turn.started", runId: "run-1", turn: 1 },
      { type: "tool.started", runId: "run-1", toolCallId: "tool-1", name: "read_document", label: "读取整份教案" },
      { type: "tool.completed", runId: "run-1", toolCallId: "tool-1", name: "read_document", label: "读取整份教案", ok: true },
      { type: "assistant.message.ended", runId: "run-1", turn: 1, outcome: "completed" },
    ], "running")).toEqual({ phase: "responding", currentTurn: 1 });
  });
});
