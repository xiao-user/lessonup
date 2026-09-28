import { describe, expect, it } from "vitest";
import { previewDocumentDraft, reduceDocumentDraft } from "./document-draft.js";
import { deriveBranchRuntimeState } from "./agent-run-control.js";
import { approvalEvent } from "./approval-state.js";

describe("isolated A4 draft", () => {
  it("projects only document fields without mutating the canonical plan", () => {
    const plan = Object.freeze({ assessment: "原文", homework: "教师作业" });
    expect(previewDocumentDraft(plan, { fields: { assessment: "生成", privateReasoning: "secret" } })).toEqual({ assessment: "生成", homework: "教师作业" });
    expect(plan.assessment).toBe("原文");
  });
  it("preserves unrelated edits and fails closed on a changed target", () => {
    const patch = { operations: [{ field: "assessment", start: 0, end: 2, expectedText: "原文", replacement: "草稿" }] };
    expect(previewDocumentDraft({ assessment: "原文追加", homework: "新作业" }, { patch })).toEqual({ assessment: "草稿追加", homework: "新作业" });
    expect(previewDocumentDraft({ assessment: "已改", homework: "新作业" }, { patch })).toBeNull();
  });
  it("discards cancelled, failed and invalid attempts, not another run's draft", () => {
    const draft = { runId: "r", toolCallId: "t" };
    expect(reduceDocumentDraft(draft, { type: "run.failed", runId: "other" })).toBe(draft);
    for (const type of ["run.failed", "run.cancelled", "document.draft.discarded"]) {
      expect(reduceDocumentDraft(draft, { type, runId: "r", toolCallId: "t" })).toBeNull();
    }
  });
  it("keeps a pending document decision independent from chat runtime", () => {
    const approval = { id: "a", runId: "old", state: "pending", patch: { baseDocumentVersion: 0 } };
    expect(deriveBranchRuntimeState({ runtimeAvailable: true, approvals: [approval], persistedRun: { id: "new", status: "running" } })).toMatchObject({ status: "streaming", runId: "new" });
    expect(deriveBranchRuntimeState({ runtimeAvailable: true, approvals: [approval], persistedRun: { id: "old", status: "completed" } })).toMatchObject({ status: "ready" });
    expect(approvalEvent([approval], { type: "approval.settled", runId: "old", approvalId: "a", decision: "rejected" })).toMatchObject([{ state: "rejected", continuationStatus: "completed" }]);
  });
});
