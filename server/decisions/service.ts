import { createHash, randomUUID } from "node:crypto";

import type { LessonRepository } from "../repository.js";
import { decisionActionSchema, decisionEventInputSchema, decisionReadQuerySchema, proposeDecisionSchema } from "./commands.js";
import type {
  DecisionCommand,
  DecisionEvent,
  DecisionRecord,
  DecisionStatus,
  EvidenceCard,
} from "./contracts.js";
import { diffDecisions } from "./diff.js";
import { transitionDecision } from "./lifecycle.js";
import { validateDecisionRecord, validateEvidenceCard } from "./validation.js";

type Scope = { ownerId: string; lessonFileId: string };
type Origin = { runId: string; threadId: string; branchId: string };

const invalid = (errors: string[]) => new Error(`decision_invalid:${errors[0] ?? "unknown"}`);

/** Decisions are teacher-owned facts; the agent may only propose candidates. */
export class DecisionService {
  constructor(
    private readonly repository: LessonRepository,
    private readonly clock = () => new Date().toISOString(),
  ) {}

  private command(scope: Scope, operation: string, input: unknown, idempotencyKey: string, documentVersion?: number): DecisionCommand {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("decision_command_key_invalid");
    return {
      idempotencyKey,
      fingerprint: createHash("sha256").update(JSON.stringify({ scope, operation, input })).digest("hex"),
      ...(documentVersion === undefined ? {} : { documentVersion }),
    };
  }

  private async file(scope: Scope) {
    const file = await this.repository.getLessonFileContext(scope.ownerId, scope.lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    return file;
  }

  private async assertOrigin(scope: Scope, origin: Origin) {
    const [run, thread, branch] = await Promise.all([
      this.repository.getRun(scope.ownerId, origin.runId),
      this.repository.getThread(scope.ownerId, origin.threadId),
      this.repository.getBranch(scope.ownerId, origin.threadId, origin.branchId),
    ]);
    if (!run || !thread || !branch || thread.resourceType !== "lesson_file"
      || thread.lessonFileId !== scope.lessonFileId || run.threadId !== thread.id
      || run.branchId !== branch.id || run.status !== "running") {
      throw new Error("decision_scope_invalid");
    }
  }

  async read(scope: Scope, rawQuery: unknown = {}) {
    const query = decisionReadQuerySchema.parse(rawQuery);
    const file = await this.file(scope);
    const decisions = await this.repository.listDecisions(scope.ownerId, file.id, query.limit, query.before);
    const evidenceIds = [...new Set(decisions.flatMap((decision) => decision.evidenceCardIds))];
    const evidenceCards = evidenceIds.length
      ? await this.repository.listDecisionEvidenceCards(scope.ownerId, file.id, evidenceIds)
      : [];
    return { decisions, evidenceCards, truncated: decisions.length === query.limit };
  }

  async readContext(scope: Scope, decisionId: string) {
    const file = await this.file(scope);
    const decision = await this.repository.getDecision(scope.ownerId, decisionId);
    if (!decision || decision.lessonFileId !== file.id) throw new Error("decision_not_found");
    const [versions, evidenceCards] = await Promise.all([
      this.repository.listDecisionVersions(scope.ownerId, decision.id),
      decision.evidenceCardIds.length
        ? this.repository.listDecisionEvidenceCards(scope.ownerId, file.id, decision.evidenceCardIds)
        : Promise.resolve([]),
    ]);
    return {
      decision,
      versions,
      evidenceCards,
      diff: versions.length > 1 ? diffDecisions(versions[versions.length - 2], versions[versions.length - 1]) : null,
    };
  }

  async propose(scope: Scope, rawInput: unknown, idempotencyKey: string, origin?: Origin) {
    const input = proposeDecisionSchema.parse(rawInput);
    const file = await this.file(scope);
    if (input.contextVersion.documentVersion !== file.documentVersion) throw new Error("stale_document");
    if (input.createdBy === "agent") {
      if (!origin) throw new Error("decision_agent_origin_required");
      await this.assertOrigin(scope, origin);
    } else if (origin) {
      await this.assertOrigin(scope, origin);
    }

    const createdAt = this.clock();
    const evidenceCards: EvidenceCard[] = input.evidenceCards.map((card) => ({
      schemaVersion: 1,
      id: randomUUID(),
      ...card,
    }));
    for (const card of evidenceCards) {
      const errors = validateEvidenceCard(card);
      if (errors.length) throw invalid(errors);
    }

    const record: DecisionRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      ownerId: scope.ownerId,
      notebookId: file.notebookId,
      lessonFileId: file.id,
      unitId: null,
      lessonBlueprintId: null,
      decisionType: input.decisionType,
      question: input.question,
      contextVersion: input.contextVersion,
      options: input.options,
      chosenOptionId: input.chosenOptionId,
      rationale: input.rationale,
      evidenceCardIds: evidenceCards.map((card) => card.id),
      counterevidence: input.counterevidence,
      assumptions: input.assumptions,
      uncertainties: input.uncertainties,
      confidence: input.confidence,
      expectedSignal: input.expectedSignal,
      falsifier: input.falsifier,
      reviewAt: input.reviewAt,
      status: input.status,
      version: 1,
      rejection: null,
      implementation: null,
      review: null,
      provenance: {
        createdBy: input.createdBy,
        modelRunId: origin?.runId ?? null,
        toolCallId: null,
        confirmedBy: null,
      },
      createdAt,
      updatedAt: createdAt,
    };
    const errors = validateDecisionRecord(record);
    if (errors.length) throw invalid(errors);
    return this.repository.saveDecision(
      record,
      null,
      this.command(scope, "propose", input, idempotencyKey, file.documentVersion),
      evidenceCards,
    );
  }

  async act(scope: Scope, decisionId: string, rawInput: unknown, idempotencyKey: string) {
    const input = decisionActionSchema.parse(rawInput);
    const file = await this.file(scope);
    const decision = await this.repository.getDecision(scope.ownerId, decisionId);
    if (!decision || decision.lessonFileId !== file.id) throw new Error("decision_not_found");
    if (decision.version !== input.expectedVersion) throw new Error("stale_decision");
    const at = this.clock();
    const next = await this.applyAction(scope, file.id, file.documentVersion, decision, input, at);
    const errors = validateDecisionRecord(next);
    if (errors.length) throw invalid(errors);
    return this.repository.saveDecision(
      next,
      decision.version,
      this.command(scope, "act", { decisionId, input }, idempotencyKey),
      [],
    );
  }

  private async applyAction(
    scope: Scope,
    lessonFileId: string,
    documentVersion: number,
    decision: DecisionRecord,
    input: ReturnType<typeof decisionActionSchema.parse>,
    at: string,
  ): Promise<DecisionRecord> {
    const versioned = { ...decision, version: decision.version + 1, updatedAt: at };
    switch (input.action) {
      case "confirm": {
        if (!decision.options.some((option) => option.id === input.chosenOptionId)) throw new Error("decision_chosen_option_invalid");
        if ((input.confidence ?? decision.confidence) === null) throw new Error("decision_confidence_required");
        const next = {
          ...versioned,
          chosenOptionId: input.chosenOptionId,
          rationale: input.rationale ?? decision.rationale,
          confidence: input.confidence ?? decision.confidence,
          expectedSignal: input.expectedSignal ?? decision.expectedSignal,
          falsifier: input.falsifier ?? decision.falsifier,
        };
        return transitionDecision(next, "teacher_confirmed", "teacher", { confirmedBy: scope.ownerId, updatedAt: at });
      }
      case "reject":
        return {
          ...transitionDecision(versioned, "teacher_rejected", "teacher", { updatedAt: at }),
          rejection: { reasonCode: input.reasonCode, rationale: input.rationale, at },
        };
      case "no_change":
        if ((input.confidence ?? decision.confidence) === null) throw new Error("decision_confidence_required");
        return {
          ...transitionDecision({ ...versioned, chosenOptionId: null }, "no_change", "teacher", { confirmedBy: scope.ownerId, updatedAt: at }),
          rationale: input.rationale,
          confidence: input.confidence ?? decision.confidence,
        };
      case "implement": {
        const implementedAt = input.implementedAt ?? at;
        if (new Date(implementedAt).getTime() > new Date(at).getTime()) throw new Error("decision_implementation_time_invalid");
        return {
          ...transitionDecision(versioned, "implemented", "teacher", { confirmedBy: scope.ownerId, updatedAt: at }),
          implementation: { implementedAt, note: input.note, documentVersion, at },
        };
      }
      case "review":
        return this.review(scope, decision, versioned, input, at);
      default:
        throw new Error("decision_action_unsupported");
    }
  }

  private async review(
    scope: Scope,
    decision: DecisionRecord,
    versioned: DecisionRecord,
    input: Extract<ReturnType<typeof decisionActionSchema.parse>, { action: "review" }>,
    at: string,
  ): Promise<DecisionRecord> {
    if (!decision.implementation) throw new Error("decision_implementation_required");
    if (new Set(input.evidenceIds).size !== input.evidenceIds.length) throw new Error("decision_review_evidence_duplicated");
    for (const evidenceId of input.evidenceIds) {
      const evidence = await this.repository.getLearningEvidence(scope.ownerId, evidenceId);
      if (!evidence || evidence.lessonFileId !== decision.lessonFileId) throw new Error("decision_review_evidence_not_found");
      if (new Date(evidence.observedAt).getTime() <= new Date(decision.implementation.implementedAt).getTime()) {
        throw new Error("decision_review_evidence_before_implementation");
      }
    }
    return {
      ...transitionDecision(versioned, "reviewed", "teacher", { confirmedBy: scope.ownerId, updatedAt: at }),
      review: {
        outcome: input.outcome,
        rationale: input.rationale,
        limitations: input.limitations,
        evidenceIds: input.evidenceIds,
        reviewedAt: at,
        at,
      },
    };
  }

  async commandResult(scope: Scope, idempotencyKey: string) {
    return this.repository.getDecisionCommandResult(scope.ownerId, idempotencyKey);
  }

  async recordEvent(scope: Scope, rawInput: unknown) {
    const input = decisionEventInputSchema.parse(rawInput);
    const file = await this.file(scope);
    return this.repository.saveDecisionEvent({
      id: randomUUID(),
      ownerId: scope.ownerId,
      lessonFileId: file.id,
      type: input.type,
      decisionId: input.decisionId ?? null,
      decisionType: input.decisionType ?? null,
      evidenceId: input.evidenceId ?? null,
      durationMs: input.durationMs ?? null,
      count: input.count ?? null,
      createdAt: this.clock(),
    });
  }

  async events(scope: Scope, limit = 200) {
    const file = await this.file(scope);
    return this.repository.listDecisionEvents(scope.ownerId, file.id, Math.min(Math.max(limit, 1), 500));
  }
}

export type { DecisionStatus };
