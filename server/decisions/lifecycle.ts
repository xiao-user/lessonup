import type { DecisionActor, DecisionRecord, DecisionStatus } from "./contracts.js";

/** Only the teacher can confirm, implement or review a decision; agents may only propose. */
const ALLOWED_TRANSITIONS: Array<{ from: DecisionStatus; to: DecisionStatus; actors: DecisionActor[] }> = [
  { from: "draft", to: "proposed", actors: ["agent", "teacher"] },
  { from: "proposed", to: "teacher_confirmed", actors: ["teacher"] },
  { from: "proposed", to: "teacher_rejected", actors: ["teacher"] },
  { from: "proposed", to: "no_change", actors: ["teacher"] },
  { from: "proposed", to: "insufficient_evidence", actors: ["teacher"] },
  { from: "insufficient_evidence", to: "proposed", actors: ["agent", "teacher"] },
  { from: "teacher_confirmed", to: "implemented", actors: ["teacher"] },
  { from: "implemented", to: "reviewed", actors: ["teacher"] },
];

const TERMINAL_FOR_SUPERSEDE: DecisionStatus[] = [
  "draft",
  "proposed",
  "insufficient_evidence",
  "teacher_confirmed",
  "teacher_rejected",
  "no_change",
  "implemented",
  "reviewed",
];

export function canTransition(from: DecisionStatus, to: DecisionStatus, actor: DecisionActor): boolean {
  if (from === to || from === "superseded") return false;
  if (to === "superseded") {
    return TERMINAL_FOR_SUPERSEDE.includes(from) && (actor === "teacher" || actor === "system");
  }
  return ALLOWED_TRANSITIONS.some((rule) => (
    rule.from === from && rule.to === to && rule.actors.includes(actor)
  ));
}

export interface TransitionMeta {
  confirmedBy?: string;
  updatedAt?: string;
}

/**
 * Returns a new record; callers persist it as an append-only version.
 * Teacher-only statuses stay unreachable for the agent even if it calls this helper.
 */
export function transitionDecision(
  record: DecisionRecord,
  to: DecisionStatus,
  actor: DecisionActor,
  meta: TransitionMeta = {},
): DecisionRecord {
  if (!canTransition(record.status, to, actor)) {
    throw new Error(`decision_transition_forbidden:${record.status}->${to}:${actor}`);
  }
  const teacherOwned = to === "teacher_confirmed" || to === "implemented" || to === "reviewed" || to === "no_change";
  if (teacherOwned && !meta.confirmedBy) throw new Error("decision_teacher_identity_required");
  return {
    ...record,
    status: to,
    updatedAt: meta.updatedAt ?? new Date().toISOString(),
    provenance: teacherOwned
      ? { ...record.provenance, confirmedBy: meta.confirmedBy ?? null }
      : record.provenance,
  };
}
