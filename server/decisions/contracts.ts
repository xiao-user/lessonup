/** Decision records are the unit of teaching judgment; documents are their expression. */

export const DECISION_TYPES = [
  "scope_priority",
  "goal_evidence",
  "task_sequence",
  "scaffolding",
  "assessment",
  "implementation_adjustment",
  "followup",
  "no_change",
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

export const DECISION_STATUSES = [
  "draft",
  "proposed",
  "insufficient_evidence",
  "teacher_confirmed",
  "teacher_rejected",
  "no_change",
  "implemented",
  "reviewed",
  "superseded",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const EVIDENCE_KINDS = [
  "curriculum_standard",
  "textbook",
  "student_work",
  "classroom_observation",
  "assessment_item",
  "teacher_history",
  "method_reference",
  "platform_data",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Primary = original material; synthetic may test the flow but never proves teaching quality. */
export const EVIDENCE_LEVELS = ["primary", "first_hand_summary", "secondary", "synthetic"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export type DecisionActor = "agent" | "teacher" | "system";

export type DecisionRejectionReason = "insufficient_evidence" | "not_applicable" | "student_mismatch" | "other";
export type DecisionReviewOutcome = "supported" | "not_supported" | "inconclusive";

export interface DecisionRejection {
  reasonCode: DecisionRejectionReason;
  rationale: string;
  at: string;
}

export interface DecisionImplementation {
  implementedAt: string;
  note: string;
  documentVersion: number;
  at: string;
}

export interface DecisionReview {
  outcome: DecisionReviewOutcome;
  rationale: string;
  limitations: string;
  evidenceIds: string[];
  reviewedAt: string;
  at: string;
}

export interface DecisionCommand {
  idempotencyKey: string;
  fingerprint: string;
  documentVersion?: number;
  expectedVersion?: number;
}

export interface DecisionCursor {
  at: string;
  id: string;
}

export interface EvidenceSource {
  system: string;
  uri: string;
  /** Required for curriculum standards and textbooks: quote must be locatable. */
  locator: string | null;
  version: string;
  capturedAt: string;
}

export interface EvidenceCard {
  schemaVersion: 1;
  id: string;
  kind: EvidenceKind;
  level: EvidenceLevel;
  source: EvidenceSource;
  excerpt: string;
  claim: string;
  /** Option ids this evidence supports; empty means context only. */
  supports: string[];
  applicability: string;
  limitations: string[];
  conflictsWith: string[];
  confidence: number;
  expiresAt: string | null;
  piiLevel: "none" | "teacher" | "student";
}

export interface DecisionOption {
  id: string;
  statement: string;
  tradeoffs: string[];
}

export interface DecisionContextVersion {
  documentVersion: number;
  frameworkVersion: number | null;
}

export interface DecisionProvenance {
  createdBy: "agent" | "teacher";
  modelRunId: string | null;
  toolCallId: string | null;
  confirmedBy: string | null;
}

export interface DecisionRecord {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  notebookId: string;
  lessonFileId: string;
  unitId: string | null;
  lessonBlueprintId: string | null;
  decisionType: DecisionType;
  question: string;
  contextVersion: DecisionContextVersion;
  options: DecisionOption[];
  chosenOptionId: string | null;
  rationale: string;
  evidenceCardIds: string[];
  counterevidence: string[];
  assumptions: string[];
  uncertainties: string[];
  confidence: number | null;
  expectedSignal: string;
  /** What observation would make this decision wrong; required to avoid unfalsifiable advice. */
  falsifier: string;
  reviewAt: string | null;
  status: DecisionStatus;
  version: number;
  rejection: DecisionRejection | null;
  implementation: DecisionImplementation | null;
  review: DecisionReview | null;
  provenance: DecisionProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionDiff {
  changed: string[];
  addedEvidence: string[];
  removedEvidence: string[];
  confidenceDelta: number | null;
  statusFrom: DecisionStatus;
  statusTo: DecisionStatus;
}
