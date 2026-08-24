import { describe, expect, it } from "vitest";

import {
  presentActivitiesForMessage,
  presentCurrentFocus,
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

  it("treats an approval interruption as part of the running turn", () => {
    expect(presentTurnState({
      messageStatus: "streaming",
      chatStatus: "awaiting_approval",
      turnStatus: "awaiting_approval",
      hasActiveApproval: true,
    })).toBe("running");
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
