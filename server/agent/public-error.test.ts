import { describe, expect, it } from "vitest";
import { DocumentPatchError } from "../document-patch.js";
import { AgentEvidenceError } from "./evidence.js";
import { publicAgentError } from "./public-error.js";

describe("publicAgentError", () => {
  it("does not expose internal document fields for stale patch text", () => {
    expect(publicAgentError(
      new DocumentPatchError("text_mismatch", "process 的原文已经变化"),
    )).toBe("stale_document");
  });

  it("turns an invalid semantic patch into an actionable public error", () => {
    expect(publicAgentError(
      new DocumentPatchError("invalid_patch", "objectives 中的修改原文不唯一"),
    )).toBe("patch_target_ambiguous");
  });

  it("preserves stable non-document error codes", () => {
    expect(publicAgentError(new Error("active_run_exists"))).toBe("active_run_exists");
    expect(publicAgentError(new Error("document_context_stale"))).toBe("document_context_stale");
    expect(publicAgentError(new Error("stale_design_basis"))).toBe("stale_design_basis");
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
    expect(publicAgentError(new Error("request timed out"))).toBe("agent_timeout");
  });

  it("classifies provider connection failures before any model response", () => {
    expect(publicAgentError(new Error("getaddrinfo ENOTFOUND model-gateway.example")))
      .toBe("agent_provider_unavailable");
    expect(publicAgentError(new Error("fetch failed: ECONNRESET")))
      .toBe("agent_provider_unavailable");
  });

  it("preserves evidence-boundary errors without exposing source bodies", () => {
    expect(publicAgentError(new AgentEvidenceError("evidence_required")))
      .toBe("evidence_required");
    expect(publicAgentError(new AgentEvidenceError("unverified_patch_citation")))
      .toBe("unverified_patch_citation");
  });
});
