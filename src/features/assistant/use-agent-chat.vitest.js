import { describe, expect, it, vi } from "vitest";

import {
  branchDisplayLabel,
  lastRetryableUserMessage,
  presentAgentError,
  resetAgentConversationState,
  resolveBranchSourceMessage,
  stopAgentRun,
  synchronizeCompletedAgentTurn,
} from "./agent-run-control.js";

describe("stopAgentRun", () => {
  it("aborts the local stream and reloads persisted messages when cancellation races completion", async () => {
    const cancelRun = vi.fn().mockRejectedValue(new Error("active_run_not_found"));
    const controller = { abort: vi.fn() };
    const reloadMessages = vi.fn().mockResolvedValue(undefined);

    await stopAgentRun({ runId: "run-1", cancelRun, controller, reloadMessages });

    expect(cancelRun).toHaveBeenCalledWith("run-1");
    expect(controller.abort).toHaveBeenCalledOnce();
    expect(reloadMessages).toHaveBeenCalledOnce();
  });
});

describe("resetAgentConversationState", () => {
  it("clears a previous approval and error when a new conversation is created", () => {
    const setApproval = vi.fn();
    const setError = vi.fn();
    const setRunId = vi.fn();
    const setStatus = vi.fn();

    resetAgentConversationState({
      runtime: { agent: true }, setApproval, setError, setRunId, setStatus,
    });

    expect(setApproval).toHaveBeenCalledWith(null);
    expect(setError).toHaveBeenCalledWith(null);
    expect(setRunId).toHaveBeenCalledWith(null);
    expect(setStatus).toHaveBeenCalledWith("ready");
  });
});

describe("synchronizeCompletedAgentTurn", () => {
  it("replaces optimistic messages before exposing branch actions", async () => {
    const loadMessages = vi.fn().mockResolvedValue(undefined);
    const listThreads = vi.fn().mockResolvedValue([{ id: "thread-1" }]);

    await expect(synchronizeCompletedAgentTurn({
      threadId: "thread-1", branchId: "branch-1", loadMessages, listThreads,
    })).resolves.toEqual([{ id: "thread-1" }]);
    expect(loadMessages).toHaveBeenCalledWith("thread-1", "branch-1");
    expect(listThreads).toHaveBeenCalledOnce();
  });
});

describe("resolveBranchSourceMessage", () => {
  it("maps an optimistic user message to its persisted record before forking", async () => {
    const records = [{ id: "message-1", role: "user", content: "继续完善" }];
    const result = await resolveBranchSourceMessage(
      { id: "optimistic-1", role: "user", content: "继续完善" },
      vi.fn().mockResolvedValue(records),
    );

    expect(result).toEqual({ message: records[0], records });
  });
});

describe("lastRetryableUserMessage", () => {
  it("returns the latest completed user turn", () => {
    expect(lastRetryableUserMessage([
      { id: "u1", role: "user", content: "第一次", status: "completed" },
      { id: "a1", role: "assistant", content: "回答", status: "completed" },
      { id: "u2", role: "user", content: "再试一次", status: "completed" },
    ])?.content).toBe("再试一次");
  });
});

describe("presentAgentError", () => {
  it("turns document conflicts into a safe recovery action", () => {
    expect(presentAgentError("stale_document")).toEqual({
      message: "教案内容已在其他会话或编辑器中更新，本次建议没有写入。",
      retryLabel: "基于最新内容重新生成",
    });
  });
});

describe("branchDisplayLabel", () => {
  it("disambiguates generic Supabase branch labels", () => {
    expect(branchDisplayLabel({ label: "分支" }, 1)).toBe("分支 2");
    expect(branchDisplayLabel({ label: "主分支" }, 0)).toBe("主分支");
  });
});
