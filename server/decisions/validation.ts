import {
  DECISION_STATUSES,
  DECISION_TYPES,
  EVIDENCE_KINDS,
  EVIDENCE_LEVELS,
  type DecisionRecord,
  type EvidenceCard,
} from "./contracts.js";

const DECISION_TYPE_SET = new Set<string>(DECISION_TYPES);
const DECISION_STATUS_SET = new Set<string>(DECISION_STATUSES);
const EVIDENCE_KIND_SET = new Set<string>(EVIDENCE_KINDS);
const EVIDENCE_LEVEL_SET = new Set<string>(EVIDENCE_LEVELS);
const PII_LEVELS = new Set(["none", "teacher", "student"]);
const CONFIRMED_STATUSES = new Set(["teacher_confirmed", "no_change", "implemented", "reviewed"]);
const OPTIONLESS_TYPES = new Set(["no_change"]);

const filled = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isoDate = (value: unknown) => filled(value) && Number.isFinite(Date.parse(value));
const ratio = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Structural checks only; truthfulness still comes from the cited source. */
export function validateEvidenceCard(card: EvidenceCard): string[] {
  const errors: string[] = [];
  if (!filled(card.id)) errors.push("evidence.id_required");
  if (!EVIDENCE_KIND_SET.has(card.kind)) errors.push("evidence.kind_invalid");
  if (!EVIDENCE_LEVEL_SET.has(card.level)) errors.push("evidence.level_invalid");
  if (!filled(card.source?.system)) errors.push("evidence.source_system_required");
  if (!filled(card.source?.uri)) errors.push("evidence.source_uri_required");
  if (!filled(card.source?.version)) errors.push("evidence.source_version_required");
  if (!isoDate(card.source?.capturedAt)) errors.push("evidence.source_captured_at_invalid");
  if ((card.kind === "curriculum_standard" || card.kind === "textbook") && !filled(card.source?.locator)) {
    errors.push("evidence.locator_required");
  }
  if (!filled(card.excerpt)) errors.push("evidence.excerpt_required");
  if (!filled(card.claim)) errors.push("evidence.claim_required");
  if (!filled(card.applicability)) errors.push("evidence.applicability_required");
  if (!Array.isArray(card.limitations) || card.limitations.length === 0) errors.push("evidence.limitations_required");
  if (!Array.isArray(card.supports)) errors.push("evidence.supports_invalid");
  if (!Array.isArray(card.conflictsWith)) errors.push("evidence.conflicts_with_invalid");
  if (!ratio(card.confidence)) errors.push("evidence.confidence_invalid");
  if (!PII_LEVELS.has(card.piiLevel)) errors.push("evidence.pii_level_invalid");
  if (card.piiLevel === "student" && !/^r2:\/\//.test(card.source?.uri ?? "")) {
    errors.push("evidence.student_data_requires_private_object");
  }
  if (card.expiresAt !== null && !isoDate(card.expiresAt)) errors.push("evidence.expires_at_invalid");
  return errors;
}

/** Returns stable error codes so tests and the agent contract can reject silently bad records. */
export function validateDecisionRecord(record: DecisionRecord): string[] {
  const errors: string[] = [];
  if (!filled(record.id)) errors.push("decision.id_required");
  if (!filled(record.ownerId)) errors.push("decision.owner_id_required");
  if (!filled(record.notebookId)) errors.push("decision.notebook_id_required");
  if (!filled(record.lessonFileId)) errors.push("decision.lesson_file_id_required");
  if (!DECISION_TYPE_SET.has(record.decisionType)) errors.push("decision.type_invalid");
  if (!DECISION_STATUS_SET.has(record.status)) errors.push("decision.status_invalid");
  if (!filled(record.question)) errors.push("decision.question_required");
  if (!Number.isInteger(record.contextVersion?.documentVersion) || record.contextVersion.documentVersion < 0) {
    errors.push("decision.context_version_invalid");
  }
  if (!isoDate(record.createdAt) || !isoDate(record.updatedAt)) errors.push("decision.timestamps_invalid");

  const options = Array.isArray(record.options) ? record.options : [];
  if (!OPTIONLESS_TYPES.has(record.decisionType) && options.length < 2) errors.push("decision.options_required");
  const optionIds = new Set<string>();
  for (const option of options) {
    if (!filled(option.id) || optionIds.has(option.id)) errors.push("decision.option_id_invalid");
    optionIds.add(option.id);
    if (!filled(option.statement)) errors.push("decision.option_statement_required");
    if (!Array.isArray(option.tradeoffs) || option.tradeoffs.length === 0) errors.push("decision.option_tradeoffs_required");
  }

  const evidenceIds = Array.isArray(record.evidenceCardIds) ? record.evidenceCardIds : [];
  if (record.status !== "insufficient_evidence" && evidenceIds.length === 0) errors.push("decision.evidence_required");
  if (new Set(evidenceIds).size !== evidenceIds.length) errors.push("decision.evidence_duplicated");

  if (record.status !== "draft" && !filled(record.rationale)) errors.push("decision.rationale_required");
  if (record.status !== "draft" && record.status !== "insufficient_evidence") {
    if (!filled(record.expectedSignal)) errors.push("decision.expected_signal_required");
    if (!filled(record.falsifier)) errors.push("decision.falsifier_required");
  }

  if (record.confidence !== null && !ratio(record.confidence)) errors.push("decision.confidence_invalid");
  if (CONFIRMED_STATUSES.has(record.status)) {
    if (record.confidence === null) errors.push("decision.confidence_required");
    if (record.status === "no_change") {
      if (record.chosenOptionId !== null && !optionIds.has(record.chosenOptionId)) {
        errors.push("decision.chosen_option_invalid");
      }
    } else if (!record.chosenOptionId || !optionIds.has(record.chosenOptionId)) {
      errors.push("decision.chosen_option_invalid");
    }
    if (!filled(record.provenance?.confirmedBy)) errors.push("decision.confirmed_by_required");
  }

  if (record.decisionType === "no_change" && !["draft", "proposed", "no_change"].includes(record.status)) {
    errors.push("decision.no_change_status_invalid");
  }
  if (record.status === "no_change" && record.decisionType !== "no_change") {
    errors.push("decision.no_change_type_invalid");
  }

  if (record.reviewAt !== null && !isoDate(record.reviewAt)) errors.push("decision.review_at_invalid");
  if (!["agent", "teacher"].includes(record.provenance?.createdBy)) errors.push("decision.provenance_invalid");
  for (const field of ["counterevidence", "assumptions", "uncertainties"] as const) {
    if (!Array.isArray(record[field])) errors.push(`decision.${field}_invalid`);
  }
  return errors;
}
