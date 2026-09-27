import { applyContinuityDecisions, continuityFingerprintFromCandidateId } from "../curriculum/continuity-adoption.js";
import { deriveFrameworkContinuity, type FrameworkUnitPointOccurrence, type ReviewedProgressionRelation } from "../curriculum/framework-continuity.js";
import type { FrameworkContinuityCandidateRecord, FrameworkContinuityResult, SetFrameworkContinuityDecisionInput } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";
import { D1SemesterFrameworkReadRepository } from "./d1-semester-framework-read-repository.js";

type Row = Record<string, unknown>;
export type D1SemesterFrameworkContinuityStore = Pick<LessonRepository, "getSemesterFrameworkContinuity" | "refreshSemesterFrameworkContinuity" | "setSemesterFrameworkContinuityDecision">;

export class D1SemesterFrameworkContinuityRepository implements D1SemesterFrameworkContinuityStore {
  private readonly reads: D1SemesterFrameworkReadRepository;
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) { this.reads = new D1SemesterFrameworkReadRepository(database); }

  async getSemesterFrameworkContinuity(ownerId: string, frameworkId: string): Promise<FrameworkContinuityResult> {
    const aggregate = await this.require(ownerId, frameworkId);
    if (!aggregate.framework.semanticReleaseId) return { status: "semantic_release_unavailable", frameworkVersion: aggregate.framework.version, candidates: [] };
    const [verified, suggested, decisions] = await Promise.all([this.verified(ownerId, frameworkId), this.derive(aggregate), this.decisions(ownerId, frameworkId)]);
    return { status: "available", frameworkVersion: aggregate.framework.version, candidates: applyContinuityDecisions(merge(verified, suggested), decisions) };
  }

  async refreshSemesterFrameworkContinuity(ownerId: string, frameworkId: string): Promise<FrameworkContinuityResult> {
    const aggregate = await this.require(ownerId, frameworkId);
    if (!aggregate.framework.semanticReleaseId) return { status: "semantic_release_unavailable", frameworkVersion: aggregate.framework.version, candidates: [] };
    const drafts = await this.derive(aggregate); const now = this.clock();
    const persistent = drafts.filter((draft) => draft.evidenceKind !== "lexical_similarity");
    await this.database.batch([
      { sql: "UPDATE framework_continuity_candidates SET active = 0, updated_at = ? WHERE owner_id = ? AND framework_id = ?", params: [now, ownerId, frameworkId] },
      ...persistent.map((draft) => ({ sql: `INSERT INTO framework_continuity_candidates (id, owner_id, framework_id, derived_from_framework_version, target_unit_id, direction, semantic_release_id, current_entity_id, current_point_name, related_entity_id, related_point_name, related_unit_id, evidence_kind, relation_id, relation_type, confidence, rationale, evidence_json, fingerprint, decision, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ?)
        ON CONFLICT(owner_id, framework_id, fingerprint) DO UPDATE SET derived_from_framework_version = excluded.derived_from_framework_version, target_unit_id = excluded.target_unit_id, direction = excluded.direction, semantic_release_id = excluded.semantic_release_id, current_entity_id = excluded.current_entity_id, current_point_name = excluded.current_point_name, related_entity_id = excluded.related_entity_id, related_point_name = excluded.related_point_name, related_unit_id = excluded.related_unit_id, evidence_kind = excluded.evidence_kind, relation_id = excluded.relation_id, relation_type = excluded.relation_type, confidence = excluded.confidence, rationale = excluded.rationale, evidence_json = excluded.evidence_json, active = 1, updated_at = excluded.updated_at`, params: [crypto.randomUUID(), ownerId, frameworkId, aggregate.framework.version, draft.targetUnitId, draft.direction, aggregate.framework.semanticReleaseId!, draft.currentEntityId, draft.currentPointName, draft.relatedEntityId, draft.relatedPointName, draft.relatedUnitId, draft.evidenceKind, draft.relationId, draft.relationType, draft.confidence, draft.rationale, JSON.stringify(draft.evidence), draft.fingerprint, now, now] })),
    ]);
    return this.getSemesterFrameworkContinuity(ownerId, frameworkId);
  }

  async setSemesterFrameworkContinuityDecision(ownerId: string, frameworkId: string, input: SetFrameworkContinuityDecisionInput): Promise<FrameworkContinuityResult> {
    const continuity = await this.getSemesterFrameworkContinuity(ownerId, frameworkId);
    const fingerprint = input.fingerprint ?? continuityFingerprintFromCandidateId(input.candidateId ?? "") ?? continuity.candidates.find((candidate) => candidate.id === input.candidateId)?.fingerprint;
    const candidate = fingerprint ? continuity.candidates.find((item) => item.fingerprint === fingerprint) : undefined;
    if (!fingerprint || !candidate) throw new Error("continuity_candidate_not_found");
    const now = this.clock();
    await this.database.batch([
      { sql: `INSERT INTO framework_continuity_decisions (owner_id, framework_id, fingerprint, decision, note, target_unit_id, direction, current_entity_id, related_entity_id, related_unit_id, evidence_kind, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, framework_id, fingerprint) DO UPDATE SET decision = excluded.decision, note = excluded.note, target_unit_id = excluded.target_unit_id, direction = excluded.direction, current_entity_id = excluded.current_entity_id, related_entity_id = excluded.related_entity_id, related_unit_id = excluded.related_unit_id, evidence_kind = excluded.evidence_kind, updated_at = excluded.updated_at`, params: [ownerId, frameworkId, fingerprint, input.decision, input.note?.trim() ?? "", candidate.targetUnitId, candidate.direction, candidate.currentEntityId, candidate.relatedEntityId, candidate.relatedUnitId, candidate.evidenceKind, now, now] },
      ...(candidate.evidenceKind === "lexical_similarity" ? [] : [{ sql: "UPDATE framework_continuity_candidates SET decision = ?, updated_at = ? WHERE owner_id = ? AND framework_id = ? AND fingerprint = ?", params: [input.decision, now, ownerId, frameworkId, fingerprint] }]),
    ]);
    return this.getSemesterFrameworkContinuity(ownerId, frameworkId);
  }

  private async derive(aggregate: Awaited<ReturnType<D1SemesterFrameworkReadRepository["getSemesterFramework"]>> extends infer Value ? Exclude<Value, null> : never) {
    const releaseId = aggregate.framework.semanticReleaseId!;
    const [nodes, mappings, relations] = await Promise.all([
      this.database.query<{ node_id: string; parent_id: string | null }>({ sql: "SELECT node_id, parent_id FROM curriculum_nodes WHERE catalog_release_id = ? AND textbook_id = ?", params: [aggregate.framework.catalogReleaseId, aggregate.framework.textbookId] }),
      this.database.query<Row>({ sql: `SELECT m.node_id, m.sequence_no, m.semantic_entity_id, m.confidence, v.canonical_name FROM curriculum_node_semantics m JOIN curriculum_semantic_entity_revisions v ON v.release_id = m.release_id AND v.semantic_entity_id = m.semantic_entity_id WHERE m.release_id = ? AND m.textbook_id = ? AND m.review_state = 'approved' AND v.review_state = 'approved'`, params: [releaseId, aggregate.framework.textbookId] }),
      this.database.query<Row>({ sql: "SELECT id, relation_type, from_entity_id, to_entity_id, confidence, rationale FROM curriculum_semantic_relations WHERE release_id = ? AND review_state = 'approved' AND relation_type IN ('prerequisite', 'supports', 'develops_into', 'transfers_to')", params: [releaseId] }),
    ]);
    const parents = new Map(nodes.rows.map((node) => [node.node_id, node.parent_id])); const unitByNode = new Map(aggregate.units.map((unit) => [unit.curriculumNodeId, unit]));
    const unitFor = (nodeId: string) => { let current: string | null | undefined = nodeId; const visited = new Set<string>(); while (current && !visited.has(current)) { visited.add(current); const unit = unitByNode.get(current); if (unit) return unit; current = parents.get(current); } return null; };
    const occurrences: FrameworkUnitPointOccurrence[] = mappings.rows.flatMap((row) => { const unit = unitFor(String(row.node_id)); return unit ? [{ unitId: unit.id, unitSortNo: unit.sortNo, nodeId: String(row.node_id), sequenceNo: Number(row.sequence_no), entityId: String(row.semantic_entity_id), pointName: String(row.canonical_name), confidence: Number(row.confidence) }] : []; });
    const reviewed: ReviewedProgressionRelation[] = relations.rows.map((row) => ({ id: String(row.id), relationType: row.relation_type as ReviewedProgressionRelation["relationType"], fromEntityId: String(row.from_entity_id), toEntityId: String(row.to_entity_id), confidence: Number(row.confidence), rationale: String(row.rationale ?? "") }));
    return deriveFrameworkContinuity({ occurrences, relations: reviewed, includeLexicalCandidates: true }).map((draft) => ({ id: `${draft.evidenceKind === "lexical_similarity" ? "lexical" : "derived"}-${draft.fingerprint}`, frameworkId: aggregate.framework.id, derivedFromFrameworkVersion: aggregate.framework.version, ...draft, decision: "candidate" as const, active: true, createdAt: this.clock(), updatedAt: this.clock() }));
  }

  private async verified(ownerId: string, frameworkId: string) { const result = await this.database.query<Row>({ sql: `${candidateSelect} WHERE owner_id = ? AND framework_id = ? AND active = 1 ORDER BY target_unit_id, direction, confidence DESC`, params: [ownerId, frameworkId] }); return result.rows.map(candidateRecord); }
  private async decisions(ownerId: string, frameworkId: string) { const result = await this.database.query<{ fingerprint: string; decision: FrameworkContinuityCandidateRecord["decision"] }>({ sql: "SELECT fingerprint, decision FROM framework_continuity_decisions WHERE owner_id = ? AND framework_id = ?", params: [ownerId, frameworkId] }); return new Map(result.rows.map((row) => [row.fingerprint, row.decision])); }
  private async require(ownerId: string, frameworkId: string) { const value = await this.reads.getSemesterFramework(ownerId, frameworkId); if (!value) throw new Error("semester_framework_not_found"); return value; }
}

const candidateSelect = "SELECT id, framework_id, derived_from_framework_version, target_unit_id, direction, current_entity_id, current_point_name, related_entity_id, related_point_name, related_unit_id, evidence_kind, relation_id, relation_type, confidence, rationale, evidence_json, fingerprint, decision, active, created_at, updated_at FROM framework_continuity_candidates";
function candidateRecord(row: Row): FrameworkContinuityCandidateRecord { return { id: String(row.id), frameworkId: String(row.framework_id), derivedFromFrameworkVersion: Number(row.derived_from_framework_version), targetUnitId: String(row.target_unit_id), direction: row.direction as FrameworkContinuityCandidateRecord["direction"], currentEntityId: String(row.current_entity_id), currentPointName: String(row.current_point_name), relatedEntityId: String(row.related_entity_id), relatedPointName: String(row.related_point_name), relatedUnitId: String(row.related_unit_id), evidenceKind: row.evidence_kind as FrameworkContinuityCandidateRecord["evidenceKind"], relationId: row.relation_id == null ? null : String(row.relation_id), relationType: row.relation_type == null ? null : row.relation_type as FrameworkContinuityCandidateRecord["relationType"], confidence: Number(row.confidence), rationale: String(row.rationale), evidence: object(row.evidence_json), fingerprint: String(row.fingerprint), decision: row.decision as FrameworkContinuityCandidateRecord["decision"], active: Boolean(row.active), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function merge(verified: FrameworkContinuityCandidateRecord[], suggested: FrameworkContinuityCandidateRecord[]) { const keys = new Set(verified.map(key)); return [...verified, ...suggested.filter((candidate) => !keys.has(key(candidate)))]; }
function key(candidate: FrameworkContinuityCandidateRecord) { return [candidate.targetUnitId, candidate.direction, candidate.currentEntityId, candidate.relatedEntityId, candidate.relatedUnitId].join(":"); }
function object(value: unknown) { try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
