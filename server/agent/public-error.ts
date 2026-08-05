import { OutputGuardrailTripwireTriggered } from "@openai/agents";
import { DocumentPatchError } from "../document-patch.js";
import { DesignBasisProjectionError } from "../design-basis-projection.js";
import { LessonDesignBasisPatchError } from "../lesson-design-basis-patch.js";
import { LessonDesignChangeError } from "../lesson-design-change.js";
import { AgentEvidenceError } from "./evidence.js";

const publicErrorCodes = new Set([
  "active_run_exists",
  "agent_not_configured",
  "approval_already_resolved",
  "approval_expired",
  "approval_resume_failed",
  "document_context_stale",
  "design_basis_context_stale",
  "resource_context_stale",
  "evidence_required",
  "knowledge_storage_not_configured",
  "knowledge_attachment_unavailable",
  "insufficient_business_context",
  "invalid_patch_proposal",
  "patch_target_ambiguous",
  "attachment_not_bound_to_run",
  "lesson_file_not_found",
  "semester_framework_input_scope_invalid",
  "semester_framework_scope_invalid",
  "run_interrupted",
  "stale_document",
  "stale_design_basis",
  "stale_resource",
  "unverified_patch_citation",
  "web_search_not_configured",
]);

export function publicAgentError(error: unknown, fallback = "agent_run_failed") {
  if (error instanceof OutputGuardrailTripwireTriggered) {
    const code = error.result.output.outputInfo?.code;
    return typeof code === "string" && publicErrorCodes.has(code)
      ? code
      : fallback;
  }
  if (error instanceof AgentEvidenceError) {
    return error.code;
  }
  if (error instanceof DocumentPatchError) {
    if (error.code === "stale_document" || error.code === "text_mismatch") {
      return "stale_document";
    }
    if (error.message.includes("原文不唯一")) return "patch_target_ambiguous";
    return "invalid_patch_proposal";
  }
  if (error instanceof DesignBasisProjectionError) return error.code;
  if (error instanceof LessonDesignBasisPatchError) {
    if (
      error.code === "unobserved_design_basis_evidence"
      || error.code === "design_basis_evidence_required"
    ) {
      return "unverified_patch_citation";
    }
    if (error.code === "stale_resource") return "stale_design_basis";
    return "invalid_patch_proposal";
  }
  if (error instanceof LessonDesignChangeError) return "invalid_patch_proposal";
  const message = error instanceof Error ? error.message : "";
  if (publicErrorCodes.has(message)) return message;
  if (/\b429\b|rate.?limit/i.test(message)) return "agent_rate_limited";
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "agent_timeout";
  return fallback;
}
