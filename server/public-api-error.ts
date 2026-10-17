import { ZodError } from "zod";
import { DesignBasisProjectionError } from "./design-basis-projection.js";

const notFound = new Set([
  "learning_inquiry_not_found",
  "notebook_not_found",
  "lesson_file_not_found",
  "semester_framework_not_found",
  "semester_unit_not_found",
  "lesson_blueprint_not_found",
  "thread_not_found",
  "parent_branch_not_found",
  "message_not_found",
  "run_not_found",
  "approval_not_found",
  "knowledge_source_not_found",
  "curriculum_node_not_found",
  "curriculum_semantic_entity_not_found",
  "presentation_not_found",
  "decision_not_found",
]);

const conflicts = new Set([
  "learning_proposal_not_delivered",
  "stale_learning_inquiry",
  "stale_document",
  "stale_design_basis",
  "stale_resource",
  "text_mismatch",
  "active_run_exists",
  "active_run_not_found",
  "approval_already_resolved",
  "approval_not_approvable",
  "curriculum_catalog_snapshot_unavailable",
  "idempotency_conflict",
  "knowledge_source_not_processing",
  "knowledge_source_not_retryable",
  "duplicate_lesson_blueprint_id",
  "duplicate_lesson_blueprint_position",
  "duplicate_lesson_blueprint_identity",
  "lesson_blueprint_lesson_exists",
  "stale_decision",
  "decision_transition_forbidden",
]);

const forbidden = new Set([
  "learning_scope_invalid",
  "learning_evidence_scope_invalid",
  "scope_denied",
  "thread_scope_invalid",
  "lesson_scope_invalid",
  "semester_framework_scope_invalid",
  "notebook_scope_invalid",
  "fork_message_scope_invalid",
  "presentation_source_scope_invalid",
  "decision_scope_invalid",
  "decision_teacher_identity_required",
]);

const unavailable = new Set([
  "agent_not_configured",
  "knowledge_storage_not_configured",
  "knowledge_indexing_not_configured",
  "presentation_renderer_unavailable",
]);

const badRequest = new Set([
  "agent_task_scope_invalid",
  "continuation_intent_conflict",
  "learning_command_key_invalid",
  "learning_implementation_time_invalid",
  "learning_transition_invalid",
  "learning_inquiry_not_implemented",
  "learning_evidence_before_implementation",
  "learning_observation_in_future",
  "learning_evidence_not_comparable",
  "learning_teacher_decision_required",
  "empty_patch",
  "knowledge_file_required",
  "knowledge_source_empty",
  "curriculum_textbook_not_found",
  "curriculum_subject_mismatch",
  "curriculum_stage_mismatch",
  "curriculum_grade_mismatch",
  "curriculum_edition_mismatch",
  "curriculum_unit_requires_textbook",
  "curriculum_unit_not_in_textbook",
  "curriculum_node_outside_semester_unit",
  "invalid_blueprint_difficulties",
  "invalid_design_basis_projection",
  "presentation_markup_not_allowed",
  "decision_command_key_invalid",
  "decision_agent_origin_required",
  "decision_chosen_option_invalid",
  "decision_confidence_required",
  "decision_implementation_time_invalid",
  "decision_implementation_required",
  "decision_review_evidence_not_found",
  "decision_review_evidence_before_implementation",
  "decision_review_evidence_duplicated",
  "decision_action_unsupported",
  "decision_limit_invalid",
]);

export function publicApiError(error: unknown) {
  if (error instanceof ZodError) {
    return { code: "invalid_request", status: 400 as const };
  }
  if (error instanceof DesignBasisProjectionError) {
    return {
      code: error.code,
      status: error.code === "stale_design_basis" ? 409 as const : 400 as const,
    };
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
  // Keep native Dashi diagnostics on the server, while allowing the classroom
  // presentation UI to give a truthful retry message instead of a generic
  // internal error.
  if (code === "decision_invalid") return { code, status: 422 as const };
  if (code === "dashi_goal_visible_slots_missing") {
    return { code: "dashi_visible_content_missing", status: 422 as const };
  }
  if (code === "dashi_goal_slide_count_mismatch") {
    return { code: "dashi_content_shape_invalid", status: 422 as const };
  }
  if (code.startsWith("dashi_goal_")) return { code: "dashi_presentation_failed", status: 422 as const };
  if (code.startsWith("dashi_native_")) return { code: "dashi_presentation_failed", status: 502 as const };
  if (code === "dashi_presentation_not_rendered") return { code: "dashi_presentation_failed", status: 502 as const };
  return { code: "internal_error", status: 500 as const };
}
