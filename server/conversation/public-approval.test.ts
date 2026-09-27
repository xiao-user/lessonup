import { describe, expect, it, vi } from "vitest";
import type { AgentApprovalRecord } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import { publicApproval } from "./public-approval.js";

const approval = {
  id: "approval", ownerId: "owner", runId: "run", state: "approved", continuationStatus: "ready",
  continuationError: "approval_resume_failed", encryptedRunState: "private-state",
  patch: { kind: "presentation_storyboard", fileId: "file" },
} as AgentApprovalRecord;

describe("public approval projection", () => {
  it("exposes saved delivery independently of a failed continuation, without private state", async () => {
    const find = vi.fn().mockResolvedValue({ id: "deck", lessonFileId: "file", storageKey: "private-object" });
    const result = await publicApproval({ findClassroomPresentationByRequest: find } as unknown as LessonRepository, approval);
    expect(find).toHaveBeenCalledWith("owner", "approval:approval");
    expect(result).toMatchObject({ state: "approved", continuationStatus: "ready", delivery: { status: "ready", presentationId: "deck" } });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result).not.toHaveProperty("ownerId");
  });

  it.each([null, { id: "another-deck", lessonFileId: "another-file" }])("does not invent delivery from a proposal or another file", async (artifact) => {
    const find = vi.fn().mockResolvedValue(artifact);
    const result = await publicApproval({ findClassroomPresentationByRequest: find } as unknown as LessonRepository, approval);
    expect(result.delivery).toBeUndefined();
  });

  it.each(["pending", "rejected"] as const)("does not look up delivery for %s approvals", async (state) => {
    const find = vi.fn();
    const result = await publicApproval({ findClassroomPresentationByRequest: find } as unknown as LessonRepository, { ...approval, state });
    expect(find).not.toHaveBeenCalled();
    expect(result.delivery).toBeUndefined();
  });
});
