import { describe, expect, it } from "vitest";
import {
  activitiesFromEvents,
  canRetryApprovalDecision,
  deriveBranchRuntimeState,
  presentAgentError,
} from "./agent-run-control.js";

describe("activitiesFromEvents", () => {
  it("keeps an approval-backed proposal successful despite an old post-approval stale event", () => {
    expect(activitiesFromEvents([
      {
        type: "tool.started",
        toolCallId: "proposal-1",
        name: "propose_document_patch",
        label: "准备修改建议",
      },
      { type: "approval.required", approvalId: "approval-1" },
      {
        type: "tool.completed",
        toolCallId: "proposal-1",
        name: "propose_document_patch",
        label: "准备修改建议",
        ok: false,
        revisionCode: "document_context_stale",
      },
      { type: "run.completed" },
    ], "completed")).toEqual([
      expect.objectContaining({
        name: "propose_document_patch",
        state: "completed",
      }),
    ]);
  });
});

describe("canRetryApprovalDecision", () => {
  it("clears approvals that the server has made terminal", () => {
    expect(canRetryApprovalDecision("stale_document")).toBe(false);
    expect(canRetryApprovalDecision("stale_design_basis")).toBe(false);
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

  it("explains a design-basis conflict as a regenerated projection", () => {
    expect(presentAgentError("stale_design_basis")).toEqual({
      message: "这项建议引用的学情或教学决定已经变化，本次投影没有写入教案。",
      retryLabel: "基于最新依据重新生成",
    });
  });

  it("does not mislabel every proposal validation failure as ambiguous source text", () => {
    expect(presentAgentError("invalid_patch_proposal")).toEqual({
      message: "助手生成的修改没有通过当前教案或设计依据校验，因此没有创建确认项，也没有写入教案。",
      retryLabel: "重新读取后生成",
    });
    expect(presentAgentError("patch_target_ambiguous")).toEqual({
      message: "教案中存在多处相同原文，助手这次没有提供足以区分目标位置的信息，因此没有创建确认项。",
      retryLabel: "指定位置后重试",
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
