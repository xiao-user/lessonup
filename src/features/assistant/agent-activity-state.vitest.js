import { describe, expect, it } from "vitest";

import {
  presentActivitiesForMessage,
  presentAssistantTimeline,
  presentCurrentFocus,
  presentProcessTraceActive,
  presentThinkingVisible,
  presentTurnPhaseLabel,
  presentTurnState,
} from "./agent-activity-state.js";

const running = [{ id: "tool-1", label: "读取教案", state: "running" }];

describe("Beautiful UI terminal activity presentation", () => {
  it("clears running state when the Pi turn fails", () => {
    expect(presentActivitiesForMessage(running, "failed")[0].state).toBe("failed");
  });

  it("clears running state when the Pi turn is cancelled or completed", () => {
    expect(presentActivitiesForMessage(running, "cancelled")[0].state).toBe("cancelled");
    expect(presentActivitiesForMessage(running, "completed")[0].state).toBe("completed");
  });

  it("keeps a real running state during an active Pi turn", () => {
    expect(presentActivitiesForMessage(running, "streaming")[0].state).toBe("running");
  });
});

describe("public Pi Turn phase", () => {
  it("keeps a real active turn running", () => {
    expect(presentTurnState({
      messageStatus: "streaming",
      chatStatus: "streaming",
      turnStatus: "running",
    })).toBe("running");
  });

  it("separates waiting for the teacher's decision from Agent work", () => {
    expect(presentTurnState({
      messageStatus: "streaming",
      chatStatus: "awaiting_approval",
      turnStatus: "awaiting_approval",
      hasActiveApproval: true,
      awaitingTeacherDecision: true,
    })).toBe("awaiting_approval");
  });

  it("keeps a decided approval's continuation run presented as work in progress", () => {
    expect(presentTurnState({
      messageStatus: "streaming",
      chatStatus: "awaiting_approval",
      turnStatus: "awaiting_approval",
      hasActiveApproval: true,
      awaitingTeacherDecision: false,
    })).toBe("running");
  });

  it("shows no current focus while the teacher decides", () => {
    expect(presentCurrentFocus(
      [{ id: "tool-1", detail: "读取当前教案", state: "running" }],
      "awaiting_approval",
    )).toBeUndefined();
  });

  it("freezes process chrome after the teacher decides unless a new tool is running", () => {
    expect(presentProcessTraceActive("running", { decided: true })).toBe(false);
    expect(presentProcessTraceActive("running", { decided: true, hasRunningActivity: true })).toBe(true);
    expect(presentProcessTraceActive("running", { decided: false })).toBe(true);
    expect(presentProcessTraceActive("awaiting_approval", { decided: false })).toBe(false);
  });

  it("lets terminal and error signals clear stale running state", () => {
    expect(presentTurnState({
      messageStatus: "failed",
      chatStatus: "streaming",
      turnStatus: "running",
    })).toBe("failed");
    expect(presentTurnState({
      messageStatus: "streaming",
      chatStatus: "error",
      turnStatus: "running",
      hasError: true,
    })).toBe("failed");
    expect(presentTurnState({
      messageStatus: "completed",
      chatStatus: "ready",
      turnStatus: "completed",
    })).toBe("completed");
  });
});

describe("public Pi current focus", () => {
  const active = [{
    id: "tool-1",
    label: "读取教案",
    detail: "读取当前教案，作为后续分析依据。",
    state: "running",
  }];

  it("uses the latest running public activity as the current focus", () => {
    expect(presentCurrentFocus(active, "running")).toBe(
      "读取当前教案，作为后续分析依据。",
    );
  });

  it("does not invent a phase label when Pi has not emitted a public activity", () => {
    expect(presentCurrentFocus([], "running")).toBeUndefined();
  });

  it("clears focus as soon as the turn becomes terminal", () => {
    expect(presentCurrentFocus(active, "failed")).toBeUndefined();
    expect(presentCurrentFocus(active, "completed")).toBeUndefined();
  });
});

describe("public Pi turn phase label", () => {
  it("names the generation phase while the model has produced nothing visible yet", () => {
    // The long private stretch before the first tool call or character: the run
    // is genuinely working, and saying so exposes no reasoning content.
    expect(presentTurnPhaseLabel("responding", false)).toBe("正在思考");
  });

  it("names the generation phase even after public text has started", () => {
    expect(presentTurnPhaseLabel("responding", true)).toBe("正在思考");
  });

  it("reports the pre-model phases as preparation", () => {
    expect(presentTurnPhaseLabel("starting")).toBe("正在准备");
    expect(presentTurnPhaseLabel("preparing")).toBe("正在准备");
  });

  it("yields to the running tool as the more specific focus", () => {
    expect(presentTurnPhaseLabel("using_tools")).toBeUndefined();
  });

  it("invents no label when Pi has published no phase", () => {
    expect(presentTurnPhaseLabel(undefined)).toBeUndefined();
  });
});

describe("presentThinkingVisible", () => {
  it("keeps thinking up for the rest of the run even after public text arrives", () => {
    expect(presentThinkingVisible({ processActive: true, toolsRunning: false })).toBe(true);
    expect(presentThinkingVisible({ processActive: true, toolsRunning: true })).toBe(false);
    expect(presentThinkingVisible({ processActive: false, toolsRunning: false })).toBe(false);
  });
});

describe("presentAssistantTimeline", () => {
  it("places each turn's process text before that turn's tools", () => {
    expect(presentAssistantTimeline(
      [
        { id: "read", label: "读取整份教案", state: "completed", turn: 1 },
        { id: "patch", label: "准备修改建议", state: "needs_revision", turn: 2 },
      ],
      {
        2: "已读取教案与上游知识点依据。现在提交确认。",
        3: "刚才的提交缺少依据引用，我补上教材出处后重新提交。",
      },
    )).toEqual([
      { type: "tools", turn: 1, activities: [expect.objectContaining({ id: "read" })] },
      { type: "text", turn: 2, content: "已读取教案与上游知识点依据。现在提交确认。" },
      { type: "tools", turn: 2, activities: [expect.objectContaining({ id: "patch" })] },
      { type: "text", turn: 3, content: "刚才的提交缺少依据引用，我补上教材出处后重新提交。" },
    ]);
  });

  it("falls back to tools then body when no per-turn text was recorded", () => {
    expect(presentAssistantTimeline(
      [{ id: "read", label: "读取整份教案", state: "completed", turn: 1 }],
      {},
      "已读取教案。",
    )).toEqual([
      { type: "tools", activities: [expect.objectContaining({ id: "read" })] },
      { type: "text", content: "已读取教案。" },
    ]);
  });
});
