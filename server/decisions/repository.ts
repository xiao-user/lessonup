import type { DecisionCommand, DecisionCursor, DecisionEvent, DecisionRecord, EvidenceCard } from "./contracts.js";

/** Durable decision facts; business rules live in DecisionService, not in SQL. */
export interface DecisionRepository {
  listDecisions(ownerId: string, lessonFileId: string, limit: number, before?: DecisionCursor): Promise<DecisionRecord[]>;
  getDecision(ownerId: string, decisionId: string): Promise<DecisionRecord | null>;
  listDecisionVersions(ownerId: string, decisionId: string): Promise<DecisionRecord[]>;
  listDecisionEvidenceCards(ownerId: string, lessonFileId: string, evidenceIds?: string[]): Promise<EvidenceCard[]>;
  getDecisionCommandResult(ownerId: string, idempotencyKey: string): Promise<DecisionRecord | null>;
  replayDecisionCommand(ownerId: string, command: DecisionCommand): Promise<DecisionRecord | null>;
  saveDecision(
    record: DecisionRecord,
    expectedVersion: number | null,
    command: DecisionCommand,
    evidenceCards: EvidenceCard[],
  ): Promise<DecisionRecord>;
  saveDecisionEvent(event: DecisionEvent): Promise<DecisionEvent>;
  listDecisionEvents(ownerId: string, lessonFileId: string, limit: number): Promise<DecisionEvent[]>;
}
