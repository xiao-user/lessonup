import { createHash, randomUUID } from "node:crypto";
import type { LessonRepository } from "../repository.js";
import { isSyntheticObservation, observationPlanSchema, observationsComparable, type ObservationPlan } from "../learning/observation-plan.js";
import type { LearningEvidence } from "../learning/domain.js";
import { decisionActionSchema, decisionEventInputSchema, decisionReadQuerySchema, proposeDecisionSchema, type ProposeDecisionInput } from "./commands.js";
import type { DecisionCommand, DecisionRecord, DecisionStatus, EvidenceCard } from "./contracts.js";
import { diffDecisions } from "./diff.js";
import { validateInternalDecisionSources } from "./internal-sources.js";
import { transitionDecision } from "./lifecycle.js";
import { validateDecisionRecord, validateEvidenceCard } from "./validation.js";

type Scope = { ownerId: string; lessonFileId: string };
type Origin = { runId: string; threadId: string; branchId: string };
type Action = ReturnType<typeof decisionActionSchema.parse>;
const invalid = (errors: string[]) => new Error(`decision_invalid:${errors[0] ?? "unknown"}`);
const editable = new Set<DecisionStatus>(["draft", "proposed", "insufficient_evidence"]);

/** Decisions, measurements and delivery have distinct authority and version boundaries. */
export class DecisionService {
  constructor(private readonly repository: LessonRepository, private readonly clock = () => new Date().toISOString()) {}

  private command(scope: Scope, operation: string, input: unknown, idempotencyKey: string, documentVersion?: number): DecisionCommand {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("decision_command_key_invalid");
    return { idempotencyKey, fingerprint: createHash("sha256").update(JSON.stringify({ scope, operation, input })).digest("hex"),
      ...(documentVersion === undefined ? {} : { documentVersion }) };
  }
  private async file(scope: Scope) {
    const file = await this.repository.getLessonFileContext(scope.ownerId, scope.lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    return file;
  }
  private async delivered(record: DecisionRecord) {
    if (!record.provenance.modelRunId) return true;
    const run = await this.repository.getRun(record.ownerId, record.provenance.modelRunId);
    return run?.status === "completed" && !run.cancelRequestedAt;
  }
  private async assertOrigin(scope: Scope, origin: Origin) {
    const [run, thread, branch] = await Promise.all([
      this.repository.getRun(scope.ownerId, origin.runId), this.repository.getThread(scope.ownerId, origin.threadId),
      this.repository.getBranch(scope.ownerId, origin.threadId, origin.branchId),
    ]);
    if (!run || !thread || !branch || thread.resourceType !== "lesson_file" || thread.lessonFileId !== scope.lessonFileId
      || run.threadId !== thread.id || run.branchId !== branch.id || run.status !== "running" || run.cancelRequestedAt) {
      throw new Error("decision_scope_invalid");
    }
  }
  async read(scope: Scope, rawQuery: unknown = {}) {
    const query = decisionReadQuerySchema.parse(rawQuery);
    const file = await this.file(scope);
    const page = await this.repository.listDecisions(scope.ownerId, file.id, query.limit, query.before);
    const visibility = await Promise.all(page.map((record) => this.delivered(record)));
    const decisions = page.filter((_, index) => visibility[index]);
    const evidenceIds = [...new Set(decisions.flatMap((decision) => decision.evidenceCardIds))];
    const evidenceCards = evidenceIds.length ? await this.repository.listDecisionEvidenceCards(scope.ownerId, file.id, evidenceIds) : [];
    const last = page.at(-1);
    return { decisions, evidenceCards, truncated: page.length === query.limit,
      next: page.length === query.limit && last ? { at: last.updatedAt, id: last.id } : null };
  }
  async readContext(scope: Scope, decisionId: string) {
    const file = await this.file(scope);
    const decision = await this.repository.getDecision(scope.ownerId, decisionId);
    if (!decision || decision.lessonFileId !== file.id) throw new Error("decision_not_found");
    if (!await this.delivered(decision)) throw new Error("decision_proposal_not_delivered");
    const [versions, evidenceCards, observations] = await Promise.all([
      this.repository.listDecisionVersions(scope.ownerId, decision.id),
      decision.evidenceCardIds.length ? this.repository.listDecisionEvidenceCards(scope.ownerId, file.id, decision.evidenceCardIds) : Promise.resolve([]),
      this.repository.listLearningEvidence(scope.ownerId, file.id, 41, undefined, decision.id),
    ]);
    return { decision, versions, evidenceCards, observations: observations.slice(0, 40),
      observationsTruncated: observations.length > 40,
      observationsNext: observations.length > 40 ? { at: observations[39]!.observedAt, id: observations[39]!.id } : null,
      diff: versions.length > 1 ? diffDecisions(versions[versions.length - 2], versions[versions.length - 1]) : null };
  }

  private async lessonEvidence(scope: Scope, refs: NonNullable<ProposeDecisionInput["lessonEvidence"]>, documentVersion: number): Promise<EvidenceCard[]> {
    if (!refs.length) return [];
    const file = await this.repository.getLessonFile(scope.ownerId, scope.lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    if (file.documentVersion !== documentVersion) throw new Error("stale_document");
    return refs.map((ref) => {
      const original = file.document[ref.field];
      if (!original || !original.replace(/\s+/g, "").includes(ref.excerpt.replace(/\s+/g, ""))) {
        throw new Error("decision_lesson_excerpt_stale");
      }
      return { schemaVersion: 1, id: randomUUID(), kind: "platform_data", level: "primary",
        source: { system: "lessonup", uri: `lessonup://lesson-files/${file.id}`, locator: ref.field,
          version: String(file.documentVersion), capturedAt: this.clock() },
        excerpt: ref.excerpt, claim: ref.claim, supports: [], applicability: ref.applicability,
        limitations: ref.limitations, conflictsWith: [], confidence: null, expiresAt: null, piiLevel: "none" };
    });
  }
  private checkCards(cards: EvidenceCard[]) {
    if (cards.length > 8) throw new Error("decision_evidence_limit");
    for (const card of cards) {
      const errors = validateEvidenceCard(card); if (errors.length) throw invalid(errors);
      if (card.source.uri.startsWith("lessonup://learning-evidence/")
        && card.level !== "synthetic"
        && isSyntheticObservation({ observation: `${card.excerpt}\n${card.claim}`, sourceReference: `${card.applicability}\n${card.limitations.join("\n")}` })) {
        throw new Error("decision_synthetic_evidence_declared_real");
      }
    }
  }
  private async baseline(scope: Scope, plan: ObservationPlan, implementedAt?: string) {
    if (!plan.baselineEvidenceId) return null;
    const baseline = await this.repository.getLearningEvidence(scope.ownerId, plan.baselineEvidenceId);
    if (!baseline || baseline.lessonFileId !== scope.lessonFileId) throw new Error("decision_baseline_not_found");
    if (plan.kind !== "learning_change" || !observationsComparable(plan, baseline)) throw new Error("decision_baseline_not_comparable");
    if (implementedAt && Date.parse(baseline.observedAt) > Date.parse(implementedAt)) throw new Error("decision_baseline_after_implementation");
    return baseline;
  }

  async propose(scope: Scope, rawInput: unknown, idempotencyKey: string, origin?: Origin) {
    const input = proposeDecisionSchema.parse(rawInput);
    const file = await this.file(scope);
    const command = this.command(scope, "propose", input, idempotencyKey, file.documentVersion);
    const replay = await this.repository.replayDecisionCommand(scope.ownerId, command);
    if (replay) return replay;
    if (input.contextVersion.documentVersion !== file.documentVersion) throw new Error("stale_document");
    if (input.createdBy === "agent" && !origin) throw new Error("decision_agent_origin_required");
    if (origin) {
      await this.assertOrigin(scope, origin);
      command.agentRun = origin;
    }
    if (origin && input.lessonEvidence?.length) throw new Error("decision_teacher_source_selection_required");
    if (input.observationPlan) await this.baseline(scope, input.observationPlan);
    const cards: EvidenceCard[] = [
      ...input.evidenceCards.map((card) => ({ schemaVersion: 1 as const, id: randomUUID(), ...card })),
      ...await this.lessonEvidence(scope, input.lessonEvidence ?? [], file.documentVersion),
    ];
    this.checkCards(cards);
    await validateInternalDecisionSources(this.repository, scope, cards);
    const at = this.clock();
    const record: DecisionRecord = {
      schemaVersion: 1, id: randomUUID(), ownerId: scope.ownerId, notebookId: file.notebookId, lessonFileId: file.id,
      unitId: null, lessonBlueprintId: null, decisionType: input.decisionType, question: input.question,
      contextVersion: input.contextVersion, options: input.options, chosenOptionId: input.chosenOptionId, rationale: input.rationale,
      evidenceCardIds: cards.map((card) => card.id), counterevidence: input.counterevidence, assumptions: input.assumptions,
      uncertainties: input.uncertainties, confidence: input.confidence, expectedSignal: input.expectedSignal, falsifier: input.falsifier,
      observationPlan: input.observationPlan ?? null, reviewAt: input.reviewAt, status: input.status, version: 1,
      rejection: null, implementation: null, review: null,
      provenance: { createdBy: input.createdBy, modelRunId: origin?.runId ?? null, toolCallId: null, confirmedBy: null },
      createdAt: at, updatedAt: at,
    };
    const errors = validateDecisionRecord(record); if (errors.length) throw invalid(errors);
    return this.repository.saveDecision(record, null, command, cards);
  }

  async act(scope: Scope, decisionId: string, rawInput: unknown, idempotencyKey: string) {
    const input = decisionActionSchema.parse(rawInput);
    const file = await this.file(scope);
    const guardsDocument = ["confirm", "no_change", "revise", "implement", "review"].includes(input.action);
    const command = this.command(scope, "act", { decisionId, input }, idempotencyKey, guardsDocument ? file.documentVersion : undefined);
    const replay = await this.repository.replayDecisionCommand(scope.ownerId, command);
    if (replay) return replay;
    const decision = await this.repository.getDecision(scope.ownerId, decisionId);
    if (!decision || decision.lessonFileId !== file.id) throw new Error("decision_not_found");
    if (decision.version !== input.expectedVersion) throw new Error("stale_decision");
    if (!await this.delivered(decision)) throw new Error("decision_proposal_not_delivered");
    if (["confirm", "no_change"].includes(input.action) && decision.contextVersion.documentVersion !== file.documentVersion) throw new Error("stale_document");
    const cards = input.action === "revise" && input.lessonEvidence !== undefined
      ? await this.lessonEvidence(scope, input.lessonEvidence, file.documentVersion) : [];
    this.checkCards(cards);
    await validateInternalDecisionSources(this.repository, scope, cards);
    let next = await this.applyAction(scope, file.documentVersion, decision, input, this.clock());
    if (input.action === "revise" && input.lessonEvidence !== undefined) next = { ...next, evidenceCardIds: cards.map((card) => card.id) };
    if (input.action === "confirm" || (input.action === "revise" && next.status === "proposed")) {
      const sources = cards.length ? cards : await this.repository.listDecisionEvidenceCards(scope.ownerId, file.id, next.evidenceCardIds);
      if (sources.some((card) => card.source.uri === `lessonup://lesson-files/${file.id}` && card.source.version !== String(file.documentVersion))) {
        throw new Error("decision_lesson_excerpt_stale");
      }
    }
    const errors = validateDecisionRecord(next); if (errors.length) throw invalid(errors);
    return this.repository.saveDecision(next, decision.version, command, cards);
  }
  private async applyAction(scope: Scope, documentVersion: number, decision: DecisionRecord, input: Action, at: string): Promise<DecisionRecord> {
    const versioned = { ...decision, version: decision.version + 1, updatedAt: at };
    switch (input.action) {
      case "revise": {
        if (!editable.has(decision.status)) throw new Error("decision_revision_after_confirmation");
        if (input.contextVersion.documentVersion !== documentVersion) throw new Error("stale_document");
        const { action: _action, expectedVersion: _expected, lessonEvidence: _refs, ...changes } = input;
        if (changes.observationPlan) await this.baseline(scope, changes.observationPlan);
        return { ...versioned, ...changes, status: changes.status ?? decision.status, chosenOptionId: null };
      }
      case "confirm": {
        if (!decision.options.some((option) => option.id === input.chosenOptionId)) throw new Error("decision_chosen_option_invalid");
        if (!(input.observationPlan ?? decision.observationPlan)) throw new Error("decision_observation_plan_required");
        const plan = observationPlanSchema.parse(input.observationPlan ?? decision.observationPlan);
        await this.baseline(scope, plan);
        const next = { ...versioned, chosenOptionId: input.chosenOptionId, rationale: input.rationale ?? decision.rationale,
          confidence: input.confidence ?? decision.confidence, expectedSignal: input.expectedSignal ?? decision.expectedSignal,
          falsifier: input.falsifier ?? decision.falsifier, assumptions: input.assumptions ?? decision.assumptions,
          uncertainties: input.uncertainties ?? decision.uncertainties, observationPlan: plan };
        return transitionDecision(next, "teacher_confirmed", "teacher", { confirmedBy: scope.ownerId, updatedAt: at });
      }
      case "reject": return { ...transitionDecision(versioned, "teacher_rejected", "teacher", { updatedAt: at }), rejection: { reasonCode: input.reasonCode, rationale: input.rationale, at } };
      case "no_change": {
        return { ...transitionDecision({ ...versioned, chosenOptionId: null }, "no_change", "teacher", { confirmedBy: scope.ownerId, updatedAt: at }), rationale: input.rationale, confidence: input.confidence ?? decision.confidence };
      }
      case "implement": {
        const implementedAt = input.implementedAt ?? at;
        if (Date.parse(implementedAt) > Date.parse(at)) throw new Error("decision_implementation_time_invalid");
        const plan = decision.observationPlan ? { ...decision.observationPlan,
          ...(input.baselineEvidenceId !== undefined ? { baselineEvidenceId: input.baselineEvidenceId } : {}) } : null;
        if (plan) await this.baseline(scope, plan, implementedAt);
        else if (input.baselineEvidenceId) throw new Error("decision_observation_plan_required");
        return { ...transitionDecision(versioned, "implemented", "teacher", { confirmedBy: scope.ownerId, updatedAt: at }),
          observationPlan: plan, implementation: { implementedAt, note: input.note, documentVersion, at } };
      }
      case "review": return this.review(scope, decision, versioned, input, at);
      case "supersede": return { ...transitionDecision(versioned, "superseded", "teacher", { updatedAt: at }), rationale: input.rationale };
    }
  }
  private async review(scope: Scope, decision: DecisionRecord, versioned: DecisionRecord, input: Extract<Action, { action: "review" }>, at: string): Promise<DecisionRecord> {
    if (!decision.implementation) throw new Error("decision_implementation_required");
    if (new Set(input.evidenceIds).size !== input.evidenceIds.length) throw new Error("decision_review_evidence_duplicated");
    const observations: LearningEvidence[] = [];
    for (const id of input.evidenceIds) {
      const evidence = await this.repository.getLearningEvidence(scope.ownerId, id);
      if (!evidence || evidence.lessonFileId !== decision.lessonFileId) throw new Error("decision_review_evidence_not_found");
      if (Date.parse(evidence.observedAt) > Date.parse(at) + 60_000) throw new Error("learning_observation_in_future");
      if (Date.parse(evidence.observedAt) <= Date.parse(decision.implementation.implementedAt)) throw new Error("decision_review_evidence_before_implementation");
      observations.push(evidence);
    }
    if (input.outcome !== "inconclusive") {
      const plan = decision.observationPlan;
      if (!plan) throw new Error("decision_observation_plan_required");
      if (observations.some((item) => item.decisionId !== decision.id)) throw new Error("decision_review_evidence_unlinked");
      if (observations.some((item) => !observationsComparable(plan, item) || item.documentVersion < decision.implementation!.documentVersion)) throw new Error("decision_review_evidence_not_comparable");
      if (plan.kind === "design_check") {
        const current = await this.file(scope);
        if (observations.some((item) => item.method !== "document_check" || item.documentVersion !== current.documentVersion)) throw new Error("decision_review_evidence_not_comparable");
      }
      if (plan.kind === "learning_change") {
        const baseline = await this.baseline(scope, plan, decision.implementation.implementedAt);
        if (!baseline) throw new Error("decision_review_baseline_required");
        if (baseline.synthetic !== false || observations.some((item) => item.synthetic !== false)
          || [baseline, ...observations].some((item) => isSyntheticObservation(item))) throw new Error("decision_review_synthetic_learning");
        if (!plan.conditions.trim()) throw new Error("decision_review_conditions_required");
      }
    }
    return { ...transitionDecision(versioned, "reviewed", "teacher", { confirmedBy: scope.ownerId, updatedAt: at }),
      review: { outcome: input.outcome, rationale: input.rationale, limitations: input.limitations,
        evidenceIds: input.evidenceIds, reviewedAt: at, at } };
  }
  async commandResult(scope: Scope, idempotencyKey: string) {
    await this.file(scope);
    const record = await this.repository.getDecisionCommandResult(scope.ownerId, idempotencyKey);
    if (record && record.lessonFileId !== scope.lessonFileId) throw new Error("decision_scope_invalid");
    return record;
  }
  async recordEvent(scope: Scope, rawInput: unknown) {
    const input = decisionEventInputSchema.parse(rawInput);
    const file = await this.file(scope);
    return this.repository.saveDecisionEvent({ id: randomUUID(), ownerId: scope.ownerId, lessonFileId: file.id,
      type: input.type, decisionId: input.decisionId ?? null, decisionType: input.decisionType ?? null,
      evidenceId: input.evidenceId ?? null, durationMs: input.durationMs ?? null, count: input.count ?? null, createdAt: this.clock() });
  }
  async events(scope: Scope, limit = 200) { const file = await this.file(scope); return this.repository.listDecisionEvents(scope.ownerId, file.id, Math.min(Math.max(limit, 1), 500)); }
}
export type { DecisionStatus };
