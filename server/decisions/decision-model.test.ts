import { describe, expect, it } from "vitest";

import type { DecisionRecord, EvidenceCard } from "./contracts.js";
import { diffDecisions } from "./diff.js";
import { canTransition, transitionDecision } from "./lifecycle.js";
import { validateDecisionRecord, validateEvidenceCard } from "./validation.js";

function baseEvidence(overrides: Partial<EvidenceCard> = {}): EvidenceCard {
  return {
    schemaVersion: 1,
    id: "ev_standard_1",
    kind: "curriculum_standard",
    level: "primary",
    source: {
      system: "curriculum_standards",
      uri: "d1://curriculum_standards/1",
      locator: "第三学段·阅读与鉴赏·第3条",
      version: "2022",
      capturedAt: "2026-10-18T00:40:00Z",
    },
    excerpt: "能联系上下文和自己的积累，推想课文中有关词句的意思，体会其表达效果。",
    claim: "本课目标应指向解释与表达效果，而非术语记忆。",
    supports: ["opt_b"],
    applicability: "第三学段阅读教学；需结合本班文本难度。",
    limitations: ["课标不规定具体课堂活动与评分方式。"],
    conflictsWith: [],
    confidence: 0.95,
    expiresAt: null,
    piiLevel: "none",
    ...overrides,
  };
}

function baseDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    schemaVersion: 1,
    id: "decision_1",
    ownerId: "user_1",
    notebookId: "notebook_1",
    lessonFileId: "lesson_1",
    unitId: "unit_1",
    lessonBlueprintId: "blueprint_1",
    decisionType: "goal_evidence",
    question: "本课‘体会反复’的达成证据应该是什么？",
    contextVersion: { documentVersion: 7, frameworkVersion: 3 },
    options: [
      { id: "opt_a", statement: "以出口条复述作为达成证据", tradeoffs: ["易评分", "不能区分复述与理解"] },
      { id: "opt_b", statement: "以无提示新段落解释作为达成证据", tradeoffs: ["更接近迁移", "评分成本更高"] },
    ],
    chosenOptionId: "opt_b",
    rationale: "目标指向理解而非术语记忆。",
    evidenceCardIds: ["ev_standard_1"],
    counterevidence: ["上次出口条显示多数学生只能复述。"],
    assumptions: ["学生已具备找出重复词句的基础。"],
    uncertainties: ["新段落难度可能引入额外负担。"],
    confidence: 0.72,
    expectedSignal: "独立解释比例上升，延迟一周仍能解释新段落。",
    falsifier: "若新段落独立解释比例未上升，或延迟后回落，则本决策不成立。",
    reviewAt: null,
    status: "proposed",
    version: 1,
    rejection: null,
    implementation: null,
    review: null,
    provenance: { createdBy: "agent", modelRunId: "run_1", toolCallId: "tool_1", confirmedBy: null },
    createdAt: "2026-10-18T00:40:00Z",
    updatedAt: "2026-10-18T00:40:00Z",
    ...overrides,
  };
}

describe("evidence cards", () => {
  it("accepts a locatable primary standard", () => {
    expect(validateEvidenceCard(baseEvidence())).toEqual([]);
  });

  it("requires a locator for standards and textbooks", () => {
    expect(validateEvidenceCard(baseEvidence({ source: { ...baseEvidence().source, locator: null } })))
      .toContain("evidence.locator_required");
    expect(validateEvidenceCard(baseEvidence({ kind: "textbook", source: { ...baseEvidence().source, locator: null } })))
      .toContain("evidence.locator_required");
  });

  it("keeps student data in private objects", () => {
    const card = baseEvidence({
      kind: "student_work",
      level: "primary",
      piiLevel: "student",
      source: { ...baseEvidence().source, system: "d1", uri: "d1://student_work/1" },
    });
    expect(validateEvidenceCard(card)).toContain("evidence.student_data_requires_private_object");
  });

  it("requires at least one limitation and a bounded confidence", () => {
    expect(validateEvidenceCard(baseEvidence({ limitations: [] }))).toContain("evidence.limitations_required");
    expect(validateEvidenceCard(baseEvidence({ confidence: 1.4 }))).toContain("evidence.confidence_invalid");
  });
});

describe("decision records", () => {
  it("rejects an unknown chosen option even before teacher confirmation", () => {
    expect(validateDecisionRecord(baseDecision({ status: "insufficient_evidence", chosenOptionId: "null" })))
      .toContain("decision.chosen_option_invalid");
    expect(validateDecisionRecord(baseDecision({ chosenOptionId: null })))
      .not.toContain("decision.chosen_option_invalid");
  });
  it("accepts a complete proposal", () => {
    expect(validateDecisionRecord(baseDecision())).toEqual([]);
  });

  it("allows insufficient evidence without a fabricated citation", () => {
    expect(validateDecisionRecord(baseDecision({
      status: "insufficient_evidence",
      evidenceCardIds: [],
      confidence: null,
      chosenOptionId: null,
    }))).toEqual([]);
  });

  it("requires at least two options and one evidence card for a proposal", () => {
    expect(validateDecisionRecord(baseDecision({ options: [baseDecision().options[0]] })))
      .toContain("decision.options_required");
    expect(validateDecisionRecord(baseDecision({ evidenceCardIds: [] })))
      .toContain("decision.evidence_required");
  });

  it("requires confidence and a teacher identity once confirmed", () => {
    expect(validateDecisionRecord(baseDecision({ status: "teacher_confirmed", confidence: null })))
      .toContain("decision.confidence_required");
    expect(validateDecisionRecord(baseDecision({
      status: "teacher_confirmed",
      provenance: { ...baseDecision().provenance, confirmedBy: null },
    }))).toContain("decision.confirmed_by_required");
  });

  it("keeps no-change decisions consistent", () => {
    expect(validateDecisionRecord(baseDecision({ decisionType: "no_change", status: "teacher_confirmed" })))
      .toContain("decision.no_change_status_invalid");
    expect(validateDecisionRecord(baseDecision({ decisionType: "no_change", status: "teacher_confirmed", options: [] })))
      .toContain("decision.no_change_status_invalid");
    expect(validateDecisionRecord(baseDecision({ status: "no_change" })))
      .toContain("decision.no_change_type_invalid");
  });

  it("rejects duplicated evidence ids", () => {
    expect(validateDecisionRecord(baseDecision({ evidenceCardIds: ["ev_1", "ev_1"] })))
      .toContain("decision.evidence_duplicated");
  });

  it("requires rejection, implementation and review facts for their states", () => {
    expect(validateDecisionRecord(baseDecision({ status: "teacher_rejected" })))
      .toContain("decision.rejection_required");
    expect(validateDecisionRecord(baseDecision({ status: "implemented" })))
      .toContain("decision.implementation_required");
    expect(validateDecisionRecord(baseDecision({ status: "reviewed" })))
      .toContain("decision.review_required");
  });

  it("does not allow outcomes before confirmation", () => {
    const implementation = {
      implementedAt: "2026-10-18T02:00:00Z", note: "", documentVersion: 7, at: "2026-10-18T02:00:00Z",
    };
    expect(validateDecisionRecord(baseDecision({
      status: "teacher_confirmed",
      implementation,
    }))).toContain("decision.premature_outcome");
  });
});

describe("decision lifecycle", () => {
  it("lets the agent propose but never confirm", () => {
    expect(canTransition("draft", "proposed", "agent")).toBe(true);
    expect(canTransition("proposed", "teacher_confirmed", "agent")).toBe(false);
    expect(canTransition("teacher_confirmed", "implemented", "agent")).toBe(false);
    expect(canTransition("proposed", "teacher_confirmed", "teacher")).toBe(true);
    expect(canTransition("proposed", "no_change", "teacher")).toBe(true);
  });

  it("requires implementation before review and allows superseding history", () => {
    expect(canTransition("teacher_confirmed", "reviewed", "teacher")).toBe(false);
    expect(canTransition("teacher_confirmed", "implemented", "teacher")).toBe(true);
    expect(canTransition("implemented", "reviewed", "teacher")).toBe(true);
    expect(canTransition("reviewed", "superseded", "system")).toBe(true);
    expect(canTransition("superseded", "proposed", "teacher")).toBe(false);
  });

  it("records who confirmed and refuses teacher-owned transitions without identity", () => {
    const confirmed = transitionDecision(baseDecision(), "teacher_confirmed", "teacher", {
      confirmedBy: "teacher_1",
      updatedAt: "2026-10-18T01:20:00Z",
    });
    expect(confirmed.status).toBe("teacher_confirmed");
    expect(confirmed.provenance.confirmedBy).toBe("teacher_1");
    expect(confirmed.updatedAt).toBe("2026-10-18T01:20:00Z");
    expect(() => transitionDecision(baseDecision(), "teacher_confirmed", "agent")).toThrow("decision_transition_forbidden");
    expect(() => transitionDecision(baseDecision(), "teacher_confirmed", "teacher")).toThrow("decision_teacher_identity_required");
  });
});

describe("decision diff", () => {
  it("shows changed judgment and evidence movement", () => {
    const previous = baseDecision();
    const next = baseDecision({
      chosenOptionId: "opt_a",
      confidence: 0.81,
      evidenceCardIds: ["ev_standard_1", "ev_student_2"],
      status: "teacher_confirmed",
      provenance: { ...previous.provenance, confirmedBy: "teacher_1" },
    });
    const diff = diffDecisions(previous, next);
    expect(diff.changed).toEqual(expect.arrayContaining([
      "chosenOptionId", "confidence", "evidenceCardIds", "status",
    ]));
    expect(diff.addedEvidence).toEqual(["ev_student_2"]);
    expect(diff.removedEvidence).toEqual([]);
    expect(diff.confidenceDelta).toBe(0.09);
    expect(diff.statusFrom).toBe("proposed");
    expect(diff.statusTo).toBe("teacher_confirmed");
  });

  it("reports no change for an identical record", () => {
    const diff = diffDecisions(baseDecision(), baseDecision());
    expect(diff.changed).toEqual([]);
    expect(diff.confidenceDelta).toBe(0);
  });
});
