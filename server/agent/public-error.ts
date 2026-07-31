import { OutputGuardrailTripwireTriggered } from "@openai/agents";
import { DocumentPatchError } from "../document-patch.js";
import { AgentEvidenceError } from "./evidence.js";

const publicErrorCodes = new Set([
  "active_run_exists",
  "agent_not_configured",
  "approval_already_resolved",
  "approval_expired",
  "approval_resume_failed",
  "document_context_stale",
  "evidence_required",
  "knowledge_storage_not_configured",
  "knowledge_attachment_unavailable",
  "insufficient_business_context",
  "invalid_patch_proposal",
  "attachment_not_bound_to_run",
  "lesson_file_not_found",
  "run_interrupted",
  "stale_document",
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
    return "invalid_patch_proposal";
  }
  const message = error instanceof Error ? error.message : "";
  if (publicErrorCodes.has(message)) return message;
  if (/\b429\b|rate.?limit/i.test(message)) return "agent_rate_limited";
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "agent_timeout";
  return fallback;
}
