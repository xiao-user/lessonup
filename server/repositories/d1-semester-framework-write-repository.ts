import type { CreateSemesterFrameworkInput, SemesterFrameworkAggregate } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";
import { D1SemesterFrameworkReadRepository } from "./d1-semester-framework-read-repository.js";

export type D1SemesterFrameworkWriteStore = Pick<LessonRepository, "createSemesterFramework">;

/** Creation command with server-side ownership, catalog and idempotency checks. */
export class D1SemesterFrameworkWriteRepository implements D1SemesterFrameworkWriteStore {
  private readonly reads: D1SemesterFrameworkReadRepository;
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) { this.reads = new D1SemesterFrameworkReadRepository(database); }

  async createSemesterFramework(ownerId: string, notebookId: string, input: CreateSemesterFrameworkInput, idempotencyKey: string): Promise<SemesterFrameworkAggregate> {
    const previous = await this.database.query<{ id: string }>({ sql: "SELECT id FROM semester_frameworks WHERE owner_id = ? AND create_idempotency_key = ? LIMIT 1", params: [ownerId, idempotencyKey] });
    if (previous.rows[0]) return (await this.reads.getSemesterFramework(ownerId, previous.rows[0].id))!;
    const [notebook, catalog] = await Promise.all([
      this.database.query<{ subject: string }>({ sql: "SELECT subject FROM notebooks WHERE owner_id = ? AND id = ? LIMIT 1", params: [ownerId, notebookId] }),
      this.database.query<{ id: string }>({ sql: "SELECT r.id FROM curriculum_catalog_current c JOIN curriculum_catalog_releases r ON r.id = c.catalog_release_id WHERE c.singleton = 1 AND r.status = 'published' AND r.snapshot_complete = 1 LIMIT 1" }),
    ]);
    if (!notebook.rows[0]) throw new Error("notebook_not_found");
    if (!catalog.rows[0]) throw new Error("curriculum_catalog_snapshot_unavailable");
    const textbook = await this.database.query<{ subject: string }>({ sql: "SELECT subject FROM curriculum_textbooks WHERE catalog_release_id = ? AND id = ? LIMIT 1", params: [catalog.rows[0].id, input.textbookId] });
    if (!textbook.rows[0]) throw new Error("curriculum_textbook_not_found");
    if (textbook.rows[0].subject !== notebook.rows[0].subject) throw new Error("curriculum_subject_mismatch");
    const semantic = await this.database.query<{ id: string }>({ sql: `SELECT r.id FROM curriculum_semantic_releases r JOIN curriculum_node_semantics m ON m.release_id = r.id
      WHERE r.status = 'published' AND r.catalog_generation_id = (SELECT generation_id FROM curriculum_catalog_releases WHERE id = ?) AND m.textbook_id = ? AND m.review_state = 'approved'
      ORDER BY r.published_at DESC LIMIT 1`, params: [catalog.rows[0].id, input.textbookId] });
    const roots = await this.database.query<{ node_id: string; sort_no: number }>({ sql: "SELECT node_id, sort_no FROM curriculum_nodes WHERE catalog_release_id = ? AND textbook_id = ? AND parent_id IS NULL ORDER BY sort_no, node_id", params: [catalog.rows[0].id, input.textbookId] });
    if (!roots.rows.length) throw new Error("curriculum_textbook_has_no_root_nodes");
    const id = crypto.randomUUID(); const now = this.clock(); const requestHash = JSON.stringify({ notebookId, input });
    await this.database.batch([
      { sql: `INSERT INTO semester_frameworks (id, owner_id, notebook_id, textbook_id, catalog_release_id, semantic_release_id, title, term, start_date, total_weeks, weekly_periods, lesson_duration_minutes, capacity_ratio, planning_horizon_weeks, context_profile_json, version, status, create_idempotency_key, create_request_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'draft', ?, ?, ?, ?)`, params: [id, ownerId, notebookId, input.textbookId, catalog.rows[0].id, semantic.rows[0]?.id ?? null, input.title, input.term, input.startDate ?? null, input.totalWeeks, input.weeklyPeriods, input.lessonDurationMinutes, input.capacityRatio, input.planningHorizonWeeks, JSON.stringify(input.contextProfile), idempotencyKey, requestHash, now, now] },
      ...roots.rows.map((node, index) => ({ sql: "INSERT INTO semester_units (id, owner_id, framework_id, curriculum_node_id, sort_no, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [crypto.randomUUID(), ownerId, id, node.node_id, index + 1, now, now] })),
      { sql: `INSERT INTO semester_framework_versions (id, owner_id, framework_id, framework_version, snapshot_json, actor, idempotency_key, request_hash, created_at)
        VALUES (?, ?, ?, 0, '{}', 'manual', ?, ?, ?)`, params: [crypto.randomUUID(), ownerId, id, `create:${idempotencyKey}`, requestHash, now] },
    ]);
    const aggregate = await this.reads.getSemesterFramework(ownerId, id); if (!aggregate) throw new Error("semester_framework_not_found");
    return aggregate;
  }
}
