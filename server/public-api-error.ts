import { ZodError } from "zod";

const notFound = new Set([
  "notebook_not_found",
  "lesson_file_not_found",
  "thread_not_found",
  "parent_branch_not_found",
  "message_not_found",
  "run_not_found",
  "approval_not_found",
  "knowledge_source_not_found",
]);

const conflicts = new Set([
  "stale_document",
  "text_mismatch",
  "active_run_exists",
  "active_run_not_found",
  "approval_already_resolved",
  "approval_not_approvable",
  "knowledge_source_not_processing",
  "knowledge_source_not_retryable",
]);

const forbidden = new Set([
  "scope_denied",
  "worker_scope_denied",
  "thread_scope_invalid",
  "lesson_scope_invalid",
  "notebook_scope_invalid",
  "fork_message_scope_invalid",
]);

const unavailable = new Set([
  "agent_not_configured",
  "knowledge_storage_not_configured",
  "knowledge_indexing_not_configured",
]);

const badRequest = new Set([
  "empty_patch",
  "knowledge_file_required",
  "knowledge_source_empty",
]);

export function publicApiError(error: unknown) {
  if (error instanceof ZodError) {
    return { code: "invalid_request", status: 400 as const };
  }
  const message = error instanceof Error ? error.message : "";
  const code = message.split(":")[0];
  if (notFound.has(code)) return { code, status: 404 as const };
  if (conflicts.has(code)) return { code, status: 409 as const };
  if (forbidden.has(code)) return { code, status: 403 as const };
  if (unavailable.has(code)) return { code, status: 503 as const };
  if (code === "knowledge_file_too_large") return { code, status: 413 as const };
  if (code === "unsupported_knowledge_file") return { code, status: 415 as const };
  if (badRequest.has(code)) return { code, status: 400 as const };
  return { code: "internal_error", status: 500 as const };
}
