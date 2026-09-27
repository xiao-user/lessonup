import { describe, expect, it } from "vitest";

import {
  persistedActivitiesFromEvents,
  persistedTurnPhaseFromEvents,
  persistedTurnTextsFromEvents,
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

  it("replaces stored agent-loop narration with the factual start description", () => {
    expect(persistedActivitiesFromEvents([
      started,
      {
        type: "tool.completed",
        runId: "run-1",
        toolCallId: "tool-1",
        name: "read_document",
        label: "读取整份教案",
        ok: true,
        detail: "读取整份教案已完成，Pi 将基于读取到的当前信息继续处理。",
      },
    ], "completed")).toEqual([
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
        detail: "读取当前教案的完整内容，作为后续分析与修改依据。",
      }),
    ]);
  });

  it("reads a self-corrected run the same way live and rehydrated", () => {
    const propose = (toolCallId: string) => ({
      runId: "run-1",
      toolCallId,
      name: "propose_document_patch",
      label: "准备教案修改确认",
    });
    expect(persistedActivitiesFromEvents([
      { type: "tool.started", ...propose("proposal-1") },
      {
        type: "tool.completed",
        ...propose("proposal-1"),
        ok: false,
        revisionCode: "semantic_quality_rejected",
      },
      { type: "tool.started", ...propose("proposal-2") },
      {
        type: "tool.completed",
        ...propose("proposal-2"),
        ok: false,
        revisionCode: "document_context_stale",
      },
      {
        type: "approval.required",
        runId: "run-1",
        approvalId: "approval-1",
        toolCallId: "proposal-2",
        patch: { fileId: "f1", baseDocumentVersion: 0, summary: "改写目标", operations: [] },
      },
    ], "awaiting_approval")).toMatchObject([
      { id: "proposal-1", state: "needs_revision" },
      { id: "proposal-2", state: "completed" },
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

describe("persistedTurnTextsFromEvents", () => {
  it("restores one public text snapshot per Pi turn", () => {
    expect(persistedTurnTextsFromEvents([
      { type: "message.turn_text", runId: "run-1", turn: 2, text: "已读取教案。" },
      { type: "message.turn_text", runId: "run-1", turn: 3, text: "刚才的提交缺少依据引用。" },
    ])).toEqual({
      2: "已读取教案。",
      3: "刚才的提交缺少依据引用。",
    });
  });
});
