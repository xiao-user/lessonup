import { describe, expect, it } from "vitest";
import {
  canRetryApprovalDecision,
  deriveBranchRuntimeState,
  presentAgentError,
} from "./agent-run-control.js";

describe("canRetryApprovalDecision", () => {
  it("clears approvals that the server has made terminal", () => {
    expect(canRetryApprovalDecision("stale_document")).toBe(false);
    expect(canRetryApprovalDecision("approval_expired")).toBe(false);
  });

  it("keeps a pending approval available after a retryable transport failure", () => {
    expect(canRetryApprovalDecision("agent_timeout")).toBe(true);
    expect(canRetryApprovalDecision("approval_resume_failed")).toBe(true);
  });
});

describe("presentAgentError", () => {
  it("explains an unavailable attachment without exposing an internal id", () => {
    expect(presentAgentError("knowledge_attachment_unavailable")).toEqual({
      message: "附带资料已被删除、尚未解析完成，或已随另一条消息发送。请重新选择资料。",
      retryLabel: "重新选择资料",
    });
  });

  it("explains why an evidence-free factual patch was blocked", () => {
    expect(presentAgentError("evidence_required")).toEqual({
      message: "这项回答依赖可核验资料，但助手没有实际读取到足够证据，因此本轮已停止。",
      retryLabel: "补充资料后重试",
    });
  });
});

describe("deriveBranchRuntimeState", () => {
  it("does not inherit a failed state from another branch", () => {
    expect(deriveBranchRuntimeState({
      runtimeAvailable: true,
      approvals: [],
      persistedRun: { id: "run-complete", status: "completed" },
    })).toEqual({ status: "ready", runId: null, error: null });
  });

  it("restores the selected branch pending approval", () => {
    expect(deriveBranchRuntimeState({
      runtimeAvailable: true,
      approvals: [{ id: "approval-1", runId: "run-1", state: "pending" }],
      persistedRun: { id: "run-1", status: "awaiting_approval" },
    })).toEqual({ status: "awaiting_approval", runId: "run-1", error: null });
  });
});
