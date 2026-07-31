import { describe, expect, it } from "vitest";
import { canRetryApprovalDecision, presentAgentError } from "./agent-run-control.js";

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
});
