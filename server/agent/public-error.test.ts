import { describe, expect, it } from "vitest";
import { DocumentPatchError } from "../document-patch.js";
import { publicAgentError } from "./public-error.js";

describe("publicAgentError", () => {
  it("does not expose internal document fields for stale patch text", () => {
    expect(publicAgentError(
      new DocumentPatchError("text_mismatch", "process 的原文已经变化"),
    )).toBe("stale_document");
  });

  it("preserves stable non-document error codes", () => {
    expect(publicAgentError(new Error("active_run_exists"))).toBe("active_run_exists");
    expect(publicAgentError(new Error("document_context_stale"))).toBe("document_context_stale");
    expect(publicAgentError(new Error("knowledge_attachment_unavailable")))
      .toBe("knowledge_attachment_unavailable");
  });

  it("does not expose provider or database error details", () => {
    expect(publicAgentError(
      new Error("401 invalid api key sk-private-value at provider.example"),
    )).toBe("agent_run_failed");
    expect(publicAgentError(
      new Error("duplicate key value violates unique constraint agent_runs_one_active_thread"),
      "approval_resume_failed",
    )).toBe("approval_resume_failed");
  });

  it("normalizes rate limits and timeouts without returning raw responses", () => {
    expect(publicAgentError(new Error("provider request failed with 429: raw body")))
      .toBe("agent_rate_limited");
    expect(publicAgentError(new Error("upstream timed out after 15000ms")))
      .toBe("agent_timeout");
  });
});
