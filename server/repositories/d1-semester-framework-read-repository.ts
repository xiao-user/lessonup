import type { FrameworkOutcomeSelectionRecord, LessonBlueprintRecord, SemesterFrameworkAggregate, SemesterFrameworkRecord, SemesterUnitRecord } from "../domain.js";
import type { LessonRepository } from "../repository.js";
import type { SqlDatabase } from "../platform/sql-database.js";

type Row = Record<string, unknown>;
export type D1SemesterFrameworkReadStore = Pick<LessonRepository, "listSemesterFrameworks" | "getSemesterFramework">;

/** Read-only aggregate projection. All mutations remain behind the approval/CAS writer. */
export class D1SemesterFrameworkReadRepository implements D1SemesterFrameworkReadStore {
  constructor(private readonly database: SqlDatabase) {}

  async listSemesterFrameworks(ownerId: string, notebookId: string): Promise<SemesterFrameworkRecord[]> {
    const result = await this.database.query<Row>({ sql: `${frameworkSelect} WHERE owner_id = ? AND notebook_id = ? ORDER BY updated_at DESC, id`, params: [ownerId, notebookId] });
    return result.rows.map(framework);
  }

  async getSemesterFramework(ownerId: string, frameworkId: string): Promise<SemesterFrameworkAggregate | null> {
    const result = await this.database.query<Row>({ sql: `${frameworkSelect} WHERE owner_id = ? AND id = ? LIMIT 1`, params: [ownerId, frameworkId] });
    const root = result.rows[0]; if (!root) return null;
    const [units, blueprints, selections] = await Promise.all([
      this.database.query<Row>({ sql: `SELECT id, framework_id, curriculum_node_id, sort_no, planned_start_week, planned_end_week, planned_periods, learning_goals, teacher_notes, status, version, created_at, updated_at FROM semester_units WHERE owner_id = ? AND framework_id = ? ORDER BY sort_no, id`, params: [ownerId, frameworkId] }),
      this.database.query<Row>({ sql: `SELECT id, framework_id, semester_unit_id, curriculum_node_id, chapter_period_no, planned_period, sort_no, title, main_activity, observable_product, assessment_evidence, anticipated_difficulties_json, planned_minutes, teacher_notes, status, version, created_at, updated_at FROM lesson_blueprints WHERE owner_id = ? AND framework_id = ? ORDER BY sort_no, id`, params: [ownerId, frameworkId] }),
      this.database.query<Row>({ sql: `SELECT id, framework_id, semester_unit_id, lesson_blueprint_id, semantic_release_id, semantic_entity_id, priority, teacher_confirmed, teacher_adjusted, adjustment_reason, created_at, updated_at FROM framework_outcome_selections WHERE owner_id = ? AND framework_id = ? ORDER BY priority, id`, params: [ownerId, frameworkId] }),
    ]);
    return { framework: framework(root), units: units.rows.map(unit), blueprints: blueprints.rows.map(blueprint), outcomeSelections: selections.rows.map(selection) };
  }
}

const frameworkSelect = "SELECT id, owner_id, notebook_id, textbook_id, catalog_release_id, semantic_release_id, title, term, start_date, total_weeks, weekly_periods, lesson_duration_minutes, capacity_ratio, planning_horizon_weeks, context_profile_json, version, status, created_at, updated_at FROM semester_frameworks";
const framework = (row: Row): SemesterFrameworkRecord => ({ id: text(row.id), ownerId: text(row.owner_id), notebookId: text(row.notebook_id), textbookId: text(row.textbook_id), catalogReleaseId: text(row.catalog_release_id), semanticReleaseId: optional(row.semantic_release_id), title: text(row.title), term: text(row.term), startDate: optional(row.start_date), totalWeeks: number(row.total_weeks), weeklyPeriods: number(row.weekly_periods), lessonDurationMinutes: number(row.lesson_duration_minutes), capacityRatio: number(row.capacity_ratio), planningHorizonWeeks: number(row.planning_horizon_weeks), contextProfile: object(row.context_profile_json), version: number(row.version), status: row.status as SemesterFrameworkRecord["status"], createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
const unit = (row: Row): SemesterUnitRecord => ({ id: text(row.id), frameworkId: text(row.framework_id), curriculumNodeId: text(row.curriculum_node_id), sortNo: number(row.sort_no), plannedStartWeek: nullableNumber(row.planned_start_week), plannedEndWeek: nullableNumber(row.planned_end_week), plannedPeriods: number(row.planned_periods), learningGoals: text(row.learning_goals), teacherNotes: text(row.teacher_notes), status: row.status as SemesterUnitRecord["status"], version: number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
const blueprint = (row: Row): LessonBlueprintRecord => ({ id: text(row.id), frameworkId: text(row.framework_id), semesterUnitId: text(row.semester_unit_id), curriculumNodeId: text(row.curriculum_node_id), chapterPeriodNo: number(row.chapter_period_no), plannedPeriod: number(row.planned_period), sortNo: number(row.sort_no), title: text(row.title), mainActivity: text(row.main_activity), observableProduct: text(row.observable_product), assessmentEvidence: text(row.assessment_evidence), anticipatedDifficulties: array(row.anticipated_difficulties_json), plannedMinutes: number(row.planned_minutes), teacherNotes: text(row.teacher_notes), status: row.status as LessonBlueprintRecord["status"], version: number(row.version), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
const selection = (row: Row): FrameworkOutcomeSelectionRecord => ({ id: text(row.id), frameworkId: text(row.framework_id), semesterUnitId: optional(row.semester_unit_id), lessonBlueprintId: optional(row.lesson_blueprint_id), semanticReleaseId: text(row.semantic_release_id), semanticEntityId: text(row.semantic_entity_id), priority: number(row.priority), teacherConfirmed: Boolean(row.teacher_confirmed), teacherAdjusted: Boolean(row.teacher_adjusted), adjustmentReason: text(row.adjustment_reason), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
const text = (value: unknown) => String(value ?? ""); const number = (value: unknown) => Number(value ?? 0); const optional = (value: unknown) => value == null ? null : String(value); const nullableNumber = (value: unknown) => value == null ? null : Number(value);
function object(value: unknown) { try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function array(value: unknown) { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
