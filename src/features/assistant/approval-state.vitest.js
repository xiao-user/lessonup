import { describe, expect, it } from "vitest";
import { approvalEvent, approvalInteraction, approvalPhase, reconcileApprovals } from "./approval-state.js";
import { activeApprovalFrom, deriveBranchRuntimeState, isAwaitingTeacherDecision } from "./agent-run-control.js";

const pending = { id: "approval", runId: "run", state: "pending", continuationStatus: "pending",
  patch: { kind: "presentation_storyboard", goal: { goal: "课堂演示", themePack: "theme09", slides: [] } } };
const approved = { ...pending, state: "approved", continuationStatus: "running" };

describe("approval lifecycle projection", () => {
  it("keeps the decision independent of submitting, executing and syncing", () => {
    expect(isAwaitingTeacherDecision(pending)).toBe(true);
    expect(isAwaitingTeacherDecision({ ...pending, transport: "submitting" })).toBe(false);
    expect(approvalPhase({ ...pending, transport: "unknown" })).toBe("syncing");
    expect(approvalInteraction({ ...pending, transport: "unknown" }, "教案").action).toBe("sync");
    expect(approvalInteraction(approved, "教案")).toMatchObject({ busy: true });
    expect(approved.state).toBe("approved");
  });

  it("distinguishes unfinished delivery, unfinished reply and rejected reply", () => {
    const recovery = { ...approved, continuationStatus: "ready" };
    expect(approvalInteraction(recovery, "教案").primaryLabel).toBe("恢复生成");
    expect(approvalInteraction({ ...recovery, delivery: { status: "ready" } }, "教案").primaryLabel).toBe("恢复回复");
    expect(approvalInteraction({ ...recovery, state: "rejected" }, "教案").description).toContain("拒绝");
    expect(approvalInteraction({ ...recovery, state: "rejected" }, "教案").primaryLabel).toBe("恢复回复");
  });

  it.each(["run.completed", "run.cancelled"])("removes active controls but retains history on %s", (type) => {
    const records = approvalEvent([approved], { type, runId: "run" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: "approved", continuationStatus: "completed" });
    expect(activeApprovalFrom(records)).toBeNull();
    expect(approvalInteraction(records[0], "教案")).toBeNull();
  });

  it("does not reopen a settled approval on event replay or an older snapshot", () => {
    const settled = { ...approved, continuationStatus: "completed" };
    expect(approvalEvent([settled], { type: "approval.required", approvalId: "approval" })).toEqual([settled]);
    expect(approvalEvent([settled], { type: "approval.decided", runId: "run", approvalId: "approval", decision: "approved" })).toEqual([settled]);
    expect(reconcileApprovals([settled], [approved])).toEqual([settled]);
  });

  it("does not confuse another run with this approval", () => {
    expect(approvalEvent([approved], { type: "run.completed", runId: "different" })).toEqual([approved]);
  });

  it("does not offer execution for expired or server-invalidated recovery", () => {
    expect(approvalPhase({ ...pending, expiresAt: "2000-01-01T00:00:00Z" })).toBe("settled");
    expect(approvalPhase({ ...approved, continuationStatus: "ready", continuationError: "stale_document" })).toBe("settled");
    expect(approvalPhase({ ...approved, continuationStatus: "ready", continuationError: "approval_resume_failed" })).toBe("recoverable");
  });

  it("uses the artifact event, never slide proposal cards, as delivery evidence", () => {
    const records = approvalEvent([approved], { type: "approval.delivered", runId: "run", approvalId: "approval", presentationId: "deck" });
    expect(records[0].delivery).toEqual({ status: "ready", presentationId: "deck" });
    expect(approvalInteraction(records[0], "教案").description).toContain("演示已保存");
  });

  it("settles after authoritative recovery even if the local transport had no terminal event", () => {
    expect(deriveBranchRuntimeState({ runtimeAvailable: true,
      approvals: [{ ...approved, continuationStatus: "completed" }],
      persistedRun: { id: "run", status: "completed" }, localRunId: "run", hasLocalStream: true,
    })).toEqual({ status: "ready", runId: null, error: null });
  });
});
