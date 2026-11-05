import { DocumentPatchError } from "../document-patch.js";
import { DesignBasisProjectionError } from "../design-basis-projection.js";
import { LessonDesignBasisPatchError } from "../lesson-design-basis-patch.js";
import { LessonDesignChangeError } from "../lesson-design-change.js";
import { AgentEvidenceError } from "./evidence.js";

const publicErrorCodes = new Set([
  "active_run_exists",
  "agent_not_configured",
  "agent_provider_error",
  "agent_provider_protocol_error",
  "agent_provider_unavailable",
  "agent_rate_limited",
  "agent_session_conflict",
  "agent_context_window_exceeded",
  "agent_timeout",
  "agent_transcript_incomplete",
  "approval_already_resolved",
  "approval_expired",
  "approval_not_found",
  "approval_resume_failed",
  "document_context_stale",
  "selection_context_stale",
  "decision_context_stale",
  "design_basis_context_stale",
  "resource_context_stale",
  "evidence_required",
  "knowledge_storage_not_configured",
  "knowledge_attachment_unavailable",
  "insufficient_business_context",
  "invalid_patch_proposal",
  "patch_target_ambiguous",
  "presentation_renderer_unavailable",
  "presentation_generation_in_progress",
  "presentation_cancelled",
  "presentation_plan_legacy",
  "presentation_proposal_missing",
  "presentation_task_stale",
  "presentation_theme_binding_failed",
  "presentation_planning_blocked",
  "presentation_proposal_blocked",
  "attachment_not_bound_to_run",
  "lesson_file_not_found",
  "semester_framework_input_scope_invalid",
  "semester_framework_scope_invalid",
  "run_interrupted",
  "active_run_not_found",
  "run_not_accepting_input",
  "run_not_continuable",
  "stale_document",
  "stale_design_basis",
  "stale_resource",
  "unverified_patch_citation",
  "web_search_not_configured",
  "write_proposal_missing",
  "thread_scope_invalid",
]);

export function publicAgentError(error: unknown, fallback = "agent_run_failed") {
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
  if (
    /timeout|timed out|ETIMEDOUT/i.test(message)
  ) {
    return "agent_timeout";
  }
  if (
    /connection error|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|upstream_error|上游服务异常/i.test(message)
  ) {
    return "agent_provider_unavailable";
  }
  return fallback;
}

/** Pi-specific provider/protocol normalization layered on the shared contract. */
export function publicPiAgentError(error: unknown, fallback = "agent_run_failed") {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "pi_provider_protocol_text_detected") return "agent_provider_protocol_error";
  if (message === "pi_run_transcript_incomplete") return "agent_transcript_incomplete";
  if (/revision|concurrent|conflict/i.test(message)) return "agent_session_conflict";
  if (message.startsWith("pi_run_failed:")) {
    const providerMessage = message.slice("pi_run_failed:".length);
    if (/timeout|timed out|ETIMEDOUT/i.test(providerMessage)) return "agent_timeout";
    if (/429|rate.?limit/i.test(providerMessage)) return "agent_rate_limited";
    if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|connection|upstream_error|上游服务异常/i.test(providerMessage)) {
      return "agent_provider_unavailable";
    }
    if (/tool|function|schema|argument|protocol|response/i.test(providerMessage)) {
      return "agent_provider_protocol_error";
    }
    return "agent_provider_error";
  }
  return publicAgentError(error, fallback);
}
