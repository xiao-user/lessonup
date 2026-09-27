import { describe, expect, it } from "vitest";
import {
  activitiesFromEvents,
  activityStateForToolCompletion,
  agentInputDisposition,
  approvalBackedToolCallIds,
  deriveBranchRuntimeState,
  presentAgentError,
  queuedInputsFromEvents,
} from "./agent-run-control.js";

describe("agentInputDisposition", () => {
  it("queues an ordinary message only while a Pi Turn is actually running", () => {
    expect(agentInputDisposition("streaming", null)).toBe("queue");
  });

  it("starts a new Turn for a pending Approval Card answer", () => {
    expect(agentInputDisposition("streaming", {
      kind: "presentation_theme",
      originalRequest: "生成课堂演示",
    })).toBe("start_turn");
  });

  it("starts a normal Turn when no run is active", () => {
    expect(agentInputDisposition("ready", null)).toBe("start_turn");
  });
});

describe("queuedInputsFromEvents", () => {
  it("restores native Pi queue items and their terminal state", () => {
    const events = [{
      type: "agent.input.queued",
      runId: "run-1",
      queueId: "queue-1",
      delivery: "steer",
      content: "改为只说明课堂活动",
    }];
    expect(queuedInputsFromEvents(events, "running")).toEqual([{
      id: "queue-1",
      delivery: "steer",
      content: "改为只说明课堂活动",
      state: "queued",
    }]);
    expect(queuedInputsFromEvents(events, "completed")[0].state).toBe("completed");
  });
});

describe("activitiesFromEvents", () => {
  it("settles every unfinished tool when Pi reports a failed terminal run", () => {
    expect(activitiesFromEvents([
      {
        type: "tool.started",
        toolCallId: "read-1",
        name: "read_document",
        label: "读取整份教案",
      },
      { type: "run.failed", runId: "run-1", error: "agent_provider_error" },
    ])).toMatchObject([{ id: "read-1", state: "failed", outcome: "failed" }]);

    expect(activitiesFromEvents([{
      type: "tool.started",
      toolCallId: "read-2",
      name: "read_document",
      label: "读取整份教案",
    }], "failed")).toMatchObject([{ id: "read-2", state: "failed" }]);
  });

  it("uses awaiting_approval as a settled tool-loop boundary", () => {
    expect(activitiesFromEvents([{
      type: "tool.started",
      toolCallId: "read-1",
      name: "read_document",
      label: "读取整份教案",
    }], "awaiting_approval")).toEqual([
      expect.objectContaining({ id: "read-1", state: "completed", outcome: "completed" }),
    ]);
  });

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

  it("settles an unfinished tool as stopped when the teacher cancels the run", () => {
    expect(activitiesFromEvents([
      {
        type: "tool.started",
        toolCallId: "read-1",
        name: "read_document",
        label: "读取整份教案",
      },
      { type: "run.cancelled", runId: "run-1" },
    ])).toMatchObject([{ id: "read-1", state: "cancelled", outcome: "cancelled" }]);

    expect(activitiesFromEvents([{
      type: "tool.started",
      toolCallId: "read-2",
      name: "read_document",
      label: "读取整份教案",
    }], "cancelled")).toMatchObject([{ id: "read-2", state: "cancelled" }]);
  });

  it("treats a post-decision propose acknowledgement as successful during live completion", () => {
    expect(activityStateForToolCompletion({
      toolCallId: "proposal-1",
      name: "propose_document_patch",
      ok: false,
      revisionCode: "document_context_stale",
    }, {
      approvalBackedToolCalls: approvalBackedToolCallIds(
        [{ id: "proposal-1", name: "propose_document_patch" }],
        [{ runId: "run-1", toolCallId: "proposal-1" }],
      ),
    })).toBe("completed");
  });

  it("keeps an earlier rejected proposal attempt visible after the run self-corrects", () => {
    // The approval proves only that proposal-2 passed preflight. Reloading the
    // thread used to mark both calls successful, hiding the correction the
    // teacher had already watched happen live.
    expect(activitiesFromEvents([
      { type: "tool.started", toolCallId: "proposal-1", name: "propose_document_patch", label: "准备修改建议" },
      {
        type: "tool.completed",
        toolCallId: "proposal-1",
        name: "propose_document_patch",
        ok: false,
        revisionCode: "semantic_quality_rejected",
      },
      { type: "tool.started", toolCallId: "proposal-2", name: "propose_document_patch", label: "准备修改建议" },
      { type: "tool.completed", toolCallId: "proposal-2", name: "propose_document_patch", ok: true },
      {
        type: "approval.required",
        runId: "run-1",
        approvalId: "approval-1",
        toolCallId: "proposal-2",
        patch: {},
      },
    ], "awaiting_approval")).toMatchObject([
      { id: "proposal-1", state: "needs_revision" },
      { id: "proposal-2", state: "completed" },
    ]);
  });

  it("attributes an approval that predates tool-call attribution to the last proposal", () => {
    expect(approvalBackedToolCallIds(
      [
        { id: "proposal-1", name: "propose_document_patch" },
        { id: "proposal-2", name: "propose_document_patch" },
      ],
      [{ runId: "run-1" }],
    )).toEqual(new Set(["proposal-2"]));
  });

  it("presents no-effect proposals as unchanged instead of failed", () => {
    expect(activityStateForToolCompletion({
      name: "propose_document_patch",
      ok: false,
      revisionCode: "no_effect_patch",
      outcome: "no_change",
    })).toBe("unchanged");
    expect(activitiesFromEvents([
      {
        type: "tool.started",
        toolCallId: "proposal-noop",
        name: "propose_document_patch",
        label: "准备修改建议",
      },
      {
        type: "tool.completed",
        toolCallId: "proposal-noop",
        name: "propose_document_patch",
        label: "现稿已符合要求，将复用当前内容",
        ok: false,
        revisionCode: "no_effect_patch",
        outcome: "no_change",
      },
    ])).toEqual([
      expect.objectContaining({
        state: "unchanged",
        outcome: "no_change",
        label: "现稿已符合要求，将复用当前内容",
      }),
    ]);
  });

  it("presents recoverable proposal revisions as needs_revision", () => {
    expect(activityStateForToolCompletion({
      name: "propose_document_patch",
      ok: false,
      revisionCode: "semantic_quality_rejected",
    })).toBe("needs_revision");
  });

  it("keeps a proposal successful after approval.decided even without approval.required in the same batch", () => {
    expect(activitiesFromEvents([
      {
        type: "tool.started",
        toolCallId: "proposal-2",
        name: "propose_document_patch",
        label: "准备修改建议",
      },
      { type: "approval.decided", approvalId: "approval-2", decision: "approved" },
      {
        type: "tool.completed",
        toolCallId: "proposal-2",
        name: "propose_document_patch",
        ok: false,
        revisionCode: "proposal_needs_revision",
      },
    ])).toEqual([
      expect.objectContaining({
        name: "propose_document_patch",
        state: "completed",
      }),
    ]);
  });
});

describe("presentAgentError", () => {
  it("does not describe a pre-request provider outage as a failed modification", () => {
    expect(presentAgentError("agent_provider_unavailable")).toEqual({
      message: "暂时无法连接模型服务。本轮尚未开始生成，也没有读取资料或修改教案。",
      retryLabel: "重新发送",
    });
  });

  it("explains a post-write continuation failure without claiming the patch was lost", () => {
    expect(presentAgentError("approval_resume_failed")).toEqual({
      message: "你的确认已写入；后续说明未能完成，可直接继续提问，不会重复写入。",
      retryLabel: "继续新一轮",
    });
  });

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

  it("keeps a failed terminal run visible without locking the conversation", () => {
    expect(deriveBranchRuntimeState({
      runtimeAvailable: true,
      approvals: [],
      persistedRun: { id: "run-failed", status: "failed", error: "agent_provider_error" },
    })).toEqual({ status: "ready", runId: null, error: null });
  });

  it("restores the selected branch pending approval", () => {
    expect(deriveBranchRuntimeState({
      runtimeAvailable: true,
      approvals: [{ id: "approval-1", runId: "run-1", state: "pending" }],
      persistedRun: { id: "run-1", status: "awaiting_approval" },
    })).toEqual({ status: "awaiting_approval", runId: "run-1", error: null });
  });

  it("does not let a completed legacy storyboard continuation block new conversation", () => {
    expect(deriveBranchRuntimeState({
      runtimeAvailable: true,
      approvals: [{
        id: "approval-legacy",
        runId: "run-legacy",
        state: "approved",
        continuationStatus: "ready",
        patch: { kind: "presentation_storyboard", slides: [] },
      }],
      persistedRun: { id: "run-legacy", status: "failed", error: "presentation_generation_failed" },
    })).toEqual({ status: "ready", runId: null, error: null });
  });
});
