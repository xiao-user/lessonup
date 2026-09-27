import { describe, expect, it } from "vitest";

import {
  conversationStateReducer,
  initialConversationState,
  shouldRecoverConversation,
} from "./conversation-state.js";

describe("selected conversation state", () => {
  it("hydrates server facts and their journal waterline in one transition", () => {
    const next = conversationStateReducer(initialConversationState, {
      type: "hydrate",
      aggregateVersion: "thread:run:running:4",
      throughSequence: 4,
      value: {
        messages: [{ id: "message-1" }],
        approvals: [{ id: "approval-1" }],
        activities: [{ id: "tool-1" }],
        status: "streaming",
        runId: "run-1",
      },
    });
    expect(next).toMatchObject({
      snapshotVersion: "thread:run:running:4",
      throughSequence: 4,
      status: "streaming",
      runId: "run-1",
    });
    expect(next.messages).toHaveLength(1);
    expect(next.approvals).toHaveLength(1);
  });

  it("retains functional setState semantics without a mirrored state atom", () => {
    const next = conversationStateReducer(initialConversationState, {
      type: "set",
      key: "messages",
      value: (current) => [...current, { id: "message-1" }],
    });
    expect(next.messages).toEqual([{ id: "message-1" }]);
    expect(initialConversationState.messages).toEqual([]);
  });

  it("uses polling only as recovery after the live POST stream is gone", () => {
    const active = {
      status: "streaming",
      runId: "run-1",
      threadId: "thread-1",
      branchId: "branch-1",
    };
    expect(shouldRecoverConversation({ ...active, hasLocalStream: true })).toBe(false);
    expect(shouldRecoverConversation({ ...active, hasLocalStream: false })).toBe(true);
    expect(shouldRecoverConversation({ ...active, status: "ready", hasLocalStream: false })).toBe(false);
    expect(shouldRecoverConversation({ ...active, status: "syncing", hasLocalStream: false })).toBe(true);
  });

  it("does not reopen the composer approval state when approval.required is replayed", () => {
    const settled = { ...initialConversationState, status: "ready", approvals: [
      { id: "approval", runId: "run", state: "approved", continuationStatus: "completed" },
    ] };
    expect(conversationStateReducer(settled, { type: "approval-event", event: {
      type: "approval.required", runId: "run", approvalId: "approval",
    } })).toBe(settled);
    expect(conversationStateReducer(settled, { type: "approval-sync-unavailable", approvalId: "approval" })).toBe(settled);
  });

  it("derives runtime state from reconciled approvals rather than the stale snapshot input", () => {
    const settled = { ...initialConversationState, status: "ready", approvals: [
      { id: "approval", runId: "run", state: "approved", continuationStatus: "completed" },
    ] };
    const hydrated = conversationStateReducer(settled, { type: "hydrate", value: { approvals: [
      { id: "approval", runId: "run", state: "approved", continuationStatus: "ready" },
    ] } });
    const next = conversationStateReducer(hydrated, { type: "restore-runtime", value: {
      runtimeAvailable: true, persistedRun: { id: "run", status: "completed" }, localRunId: "run",
    } });
    expect(next.status).toBe("ready");
  });
});
