import type { AgentSessionItem as AgentInputItem } from "../repository.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { defaultClassFeedbackWritebackStatus } from "../curriculum/continuity-adoption.js";
import type {
  AgentApprovalRecord,
  AgentBranchRecord,
  AgentMessageRecord,
  AgentRunEvidenceRecord,
  AgentRunRecord,
  AgentResourceRef,
  AgentThreadRecord,
  CurriculumCatalogReleaseRecord,
  CurriculumNodeRecord,
  CurriculumNodeKnowledgeRecord,
  CurriculumNodeSemanticsRecord,
  CurriculumKnowledgeContinuityRecord,
  CurriculumKnowledgeSearchResult,
  CurriculumSemanticEntityRecord,
  CurriculumSemanticPathStep,
  CurriculumTextbookRecord,
  CreateSemesterFrameworkInput,
  CreateLessonBlueprintInput,
  DeleteLessonBlueprintInput,
  CreateLessonClassFeedbackInput,
  FrameworkOutcomeSelectionRecord,
  FrameworkContinuityCandidateRecord,
  KnowledgeResult,
  LessonClassFeedbackRecord,
  LessonDesignBasisAggregate,
  LessonDesignBasisEntryRecord,
  LessonDesignBasisPatch,
  LessonDesignBasisRecord,
  LessonBlueprintRecord,
  LessonFileRecord,
  NotebookRecord,
  SetFrameworkContinuityDecisionInput,
  SourceRef,
  NormalizedAgentEvent,
  SemesterFrameworkAggregate,
  SemesterFrameworkRecord,
  SemesterFrameworkPatch,
  SemesterUnitRecord,
  UpdateLessonBlueprintInput,
} from "../domain.js";
import { lessonContextProfileSchema, lessonPlanSchema } from "../domain.js";
import { runEvidenceIdentity, uniqueRunEvidenceSources } from "../run-evidence.js";
import {
  buildCurriculumFacets,
  buildCurriculumOutline,
  normalizeCurriculumNodeQuery,
  searchCurriculumNodeRecords,
  type CurriculumTextbookFilter,
} from "../curriculum/catalog.js";
import {
  applyContinuityDecisions,
  continuityFingerprintFromCandidateId,
} from "../curriculum/continuity-adoption.js";
import { deriveFrameworkContinuity } from "../curriculum/framework-continuity.js";
import type {
  AgentRuntimeName,
  AgentRuntimeSessionSnapshot,
  CreateThreadInput,
  ImportedNotebook,
  LessonRepository,
} from "../repository.js";
import { createLessonPlanPreview } from "../../src/lib/lesson-preview.js";
import { persistedActivitiesFromEvents, persistedTurnPhaseFromEvents } from "../agent-activity-presentation.js";
import {
  type BeginClassroomPresentationGenerationResult,
  type ClassroomPresentationGeneration,
  type DirectClassroomPresentationRecord,
} from "../presentations/domain.js";
import { dashiGoalSchema } from "../presentations/dashi-goal.js";

const mapCurriculumTextbook = (row: Record<string, any>): CurriculumTextbookRecord => ({
  id: row.id ?? row.textbook_id,
  title: row.title,
  stage: row.stage,
  subject: row.subject,
  edition: row.edition,
  grade: row.grade,
  volume: row.volume ?? "",
  publisherId: row.publisher_id ?? "",
  ebookId: row.ebook_id ?? null,
  detailUrl: row.detail_url ?? null,
  treeUrl: row.tree_url ?? null,
  sourcePdfUrl: row.source_pdf_url ?? null,
  sourceListUrl: row.source_list_url ?? null,
  nodeCount: row.node_count ?? 0,
  sourceUpdatedAt: row.source_updated_at ?? null,
});

const mapCurriculumCatalogRelease = (
  row: Record<string, any>,
): CurriculumCatalogReleaseRecord => ({
  id: row.id,
  generationId: row.generation_id,
  status: row.status,
  snapshotComplete: row.snapshot_complete,
  manifest: row.manifest ?? {},
  textbookCount: Number(row.textbook_count ?? 0),
  nodeCount: Number(row.node_count ?? 0),
  createdAt: row.created_at,
  publishedAt: row.published_at ?? null,
  retiredAt: row.retired_at ?? null,
});

const mapCurriculumNode = (row: Record<string, any>): CurriculumNodeRecord => ({
  textbookId: row.textbook_id,
  nodeId: row.node_id,
  parentId: row.parent_id ?? null,
  level: row.level,
  sortNo: row.sort_no,
  title: row.title,
  pageNumber: row.page_number ?? null,
});

const mapSemesterFramework = (row: Record<string, any>): SemesterFrameworkRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  notebookId: row.notebook_id,
  textbookId: row.textbook_id,
  catalogReleaseId: row.catalog_release_id,
  semanticReleaseId: row.semantic_release_id ?? null,
  title: row.title,
  term: row.term,
  startDate: row.start_date ?? null,
  totalWeeks: Number(row.total_weeks),
  weeklyPeriods: Number(row.weekly_periods),
  lessonDurationMinutes: Number(row.lesson_duration_minutes),
  capacityRatio: Number(row.capacity_ratio),
  planningHorizonWeeks: Number(row.planning_horizon_weeks),
  contextProfile: row.context_profile ?? {},
  version: Number(row.version),
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapSemesterUnit = (row: Record<string, any>): SemesterUnitRecord => ({
  id: row.id,
  frameworkId: row.framework_id,
  curriculumNodeId: row.curriculum_node_id,
  sortNo: Number(row.sort_no),
  plannedStartWeek: row.planned_start_week == null ? null : Number(row.planned_start_week),
  plannedEndWeek: row.planned_end_week == null ? null : Number(row.planned_end_week),
  plannedPeriods: Number(row.planned_periods),
  learningGoals: row.learning_goals ?? "",
  teacherNotes: row.teacher_notes ?? "",
  status: row.status,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapLessonBlueprint = (row: Record<string, any>): LessonBlueprintRecord => ({
  id: row.id,
  frameworkId: row.framework_id,
  semesterUnitId: row.semester_unit_id,
  curriculumNodeId: row.curriculum_node_id,
  chapterPeriodNo: Number(row.chapter_period_no ?? 1),
  plannedPeriod: Number(row.planned_period),
  sortNo: Number(row.sort_no),
  title: row.title,
  mainActivity: row.main_activity ?? "",
  observableProduct: row.observable_product ?? "",
  assessmentEvidence: row.assessment_evidence ?? "",
  anticipatedDifficulties: row.anticipated_difficulties ?? [],
  plannedMinutes: Number(row.planned_minutes ?? 40),
  teacherNotes: row.teacher_notes ?? "",
  status: row.status,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapFrameworkOutcomeSelection = (
  row: Record<string, any>,
): FrameworkOutcomeSelectionRecord => ({
  id: row.id,
  frameworkId: row.framework_id,
  semesterUnitId: row.semester_unit_id ?? null,
  lessonBlueprintId: row.lesson_blueprint_id ?? null,
  semanticReleaseId: row.semantic_release_id,
  semanticEntityId: row.semantic_entity_id,
  priority: Number(row.priority),
  teacherConfirmed: Boolean(row.teacher_confirmed),
  teacherAdjusted: Boolean(row.teacher_adjusted),
  adjustmentReason: row.adjustment_reason ?? "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapLessonDesignBasis = (row: Record<string, any>): LessonDesignBasisRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  notebookId: row.notebook_id,
  lessonFileId: row.lesson_file_id,
  frameworkId: row.framework_id ?? null,
  semesterUnitId: row.semester_unit_id ?? null,
  lessonBlueprintId: row.lesson_blueprint_id ?? null,
  catalogReleaseId: row.catalog_release_id ?? null,
  textbookId: row.textbook_id ?? null,
  curriculumNodeId: row.curriculum_node_id ?? null,
  semanticReleaseId: row.semantic_release_id ?? null,
  sourceFrameworkVersion: row.source_framework_version == null
    ? null
    : Number(row.source_framework_version),
  sourceBlueprintVersion: row.source_blueprint_version == null
    ? null
    : Number(row.source_blueprint_version),
  learnerContext: row.learner_context ?? {},
  teacherNotes: row.teacher_notes ?? "",
  status: row.status,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapLessonDesignBasisEntry = (
  row: Record<string, any>,
): LessonDesignBasisEntryRecord => ({
  id: row.id,
  basisId: row.basis_id,
  kind: row.kind,
  semanticEntityId: row.semantic_entity_id ?? null,
  semanticEntityName: row.semantic_entity_name ?? null,
  relatedSemanticEntityId: row.related_semantic_entity_id ?? null,
  relatedSemanticEntityName: row.related_semantic_entity_name ?? null,
  relatedCurriculumNodeId: row.related_curriculum_node_id ?? null,
  relatedCurriculumNodeTitle: row.related_curriculum_node_title ?? null,
  statement: row.statement,
  rationale: row.rationale ?? "",
  evidence: row.evidence ?? [],
  decision: row.decision,
  teacherConfirmed: Boolean(row.teacher_confirmed),
  origin: row.origin,
  sortNo: Number(row.sort_no),
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapLessonDesignBasisAggregate = (
  payload: Record<string, any>,
): LessonDesignBasisAggregate => ({
  basis: mapLessonDesignBasis(payload.basis),
  entries: (payload.entries ?? []).map(mapLessonDesignBasisEntry),
});

const mapFrameworkContinuityCandidate = (
  row: Record<string, any>,
): FrameworkContinuityCandidateRecord => ({
  id: row.id,
  frameworkId: row.framework_id,
  derivedFromFrameworkVersion: Number(row.derived_from_framework_version),
  targetUnitId: row.target_unit_id,
  direction: row.direction,
  currentEntityId: row.current_entity_id,
  currentPointName: row.current_point_name,
  relatedEntityId: row.related_entity_id,
  relatedPointName: row.related_point_name,
  relatedUnitId: row.related_unit_id,
  evidenceKind: row.evidence_kind,
  relationId: row.relation_id ?? null,
  relationType: row.relation_type ?? null,
  confidence: Number(row.confidence),
  rationale: row.rationale,
  evidence: row.evidence ?? {},
  fingerprint: String(row.fingerprint),
  decision: row.decision,
  active: Boolean(row.active),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function mergeFrameworkContinuityCandidates(
  verified: FrameworkContinuityCandidateRecord[],
  suggested: FrameworkContinuityCandidateRecord[],
) {
  const keys = new Set(verified.map((candidate) => [
    candidate.targetUnitId,
    candidate.direction,
    candidate.currentEntityId,
    candidate.relatedEntityId,
    candidate.relatedUnitId,
  ].join(":")));
  return [...verified, ...suggested.filter((candidate) => !keys.has([
    candidate.targetUnitId,
    candidate.direction,
    candidate.currentEntityId,
    candidate.relatedEntityId,
    candidate.relatedUnitId,
  ].join(":")))].sort((left, right) => (
    left.targetUnitId.localeCompare(right.targetUnitId)
    || left.direction.localeCompare(right.direction)
    || (left.evidenceKind === "lexical_similarity" ? 1 : 0)
      - (right.evidenceKind === "lexical_similarity" ? 1 : 0)
    || right.confidence - left.confidence
  ));
}

const mapSemesterFrameworkAggregate = (payload: Record<string, any>): SemesterFrameworkAggregate => ({
  framework: mapSemesterFramework(payload.framework),
  units: (payload.units ?? []).map(mapSemesterUnit),
  blueprints: (payload.blueprints ?? []).map(mapLessonBlueprint),
  outcomeSelections: (payload.outcomeSelections ?? []).map(mapFrameworkOutcomeSelection),
});

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data == null) throw new Error("record_not_found");
  return result.data;
}

const mapThread = (row: Record<string, any>): AgentThreadRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  notebookId: row.notebook_id,
  resourceType: row.resource_type ?? "lesson_file",
  ...(row.resource_type === "semester_framework"
    ? { semesterFrameworkId: row.semester_framework_id }
    : { lessonFileId: row.lesson_file_id }),
  title: row.title,
  status: row.status,
  starterSuggestions: row.starter_suggestions ?? [],
  starterSuggestionsDocumentVersion: row.starter_suggestions_document_version == null
    ? undefined
    : Number(row.starter_suggestions_document_version),
  starterSuggestionsResourceVersion: row.starter_suggestions_resource_version == null
    ? undefined
    : Number(row.starter_suggestions_resource_version),
  archivedAt: row.archived_at ?? undefined,
  deletedAt: row.deleted_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
}) as AgentThreadRecord;

const mapBranch = (row: Record<string, any>): AgentBranchRecord => ({
  id: row.id, ownerId: row.owner_id, threadId: row.thread_id,
  parentBranchId: row.parent_branch_id ?? undefined,
  forkedFromMessageId: row.forked_from_message_id ?? undefined,
  label: row.label, pendingInteraction: row.pending_interaction ?? null, createdAt: row.created_at,
});

const mapMessage = (row: Record<string, any>): AgentMessageRecord => ({
  id: row.id, ownerId: row.owner_id, threadId: row.thread_id, branchId: row.branch_id,
  role: row.role, content: row.content, status: row.status,
  error: row.error ?? undefined,
  sources: row.sources ?? undefined,
  sessionCursor: row.session_cursor == null ? undefined : Number(row.session_cursor),
  createdAt: row.created_at,
});

const mapRuntimeSession = (row: Record<string, any>): AgentRuntimeSessionSnapshot => ({
  ownerId: row.owner_id,
  threadId: row.thread_id,
  branchId: row.branch_id,
  runtime: row.runtime,
  revision: Number(row.revision),
  messages: row.messages ?? [],
  updatedAt: row.updated_at,
});

const mapRun = (row: Record<string, any>): AgentRunRecord => ({
  id: row.id, ownerId: row.owner_id, threadId: row.thread_id, branchId: row.branch_id,
  model: row.model, status: row.status, capabilityPlan: row.capability_plan ?? undefined,
  agentDefinitionVersion: row.agent_definition_version ?? undefined,
  skillVersions: row.skill_versions ?? undefined,
  attachmentSourceIds: row.attachment_source_ids ?? undefined,
  tokenUsage: row.token_usage ?? undefined,
  providerCost: row.provider_cost == null ? undefined : Number(row.provider_cost),
  error: row.error ?? undefined, startedAt: row.started_at, completedAt: row.completed_at ?? undefined,
  leaseToken: row.lease_token ?? undefined,
  leaseExpiresAt: row.lease_expires_at ?? undefined,
  heartbeatAt: row.heartbeat_at ?? undefined,
  cancelRequestedAt: row.cancel_requested_at ?? undefined,
  assistantMessageId: row.assistant_message_id ?? undefined,
});

const mapApproval = (row: Record<string, any>): AgentApprovalRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  runId: row.run_id,
  threadId: row.thread_id,
  branchId: row.branch_id,
  assistantMessageId: row.assistant_message_id ?? undefined,
  state: row.state,
  patch: row.patch,
  encryptedRunState: row.encrypted_run_state,
  agentDefinitionVersion: row.agent_definition_version,
  resourceType: row.resource_type ?? undefined,
  patchKind: row.patch_kind ?? undefined,
  lessonFileId: row.lesson_file_id ?? undefined,
  semesterFrameworkId: row.semester_framework_id ?? undefined,
  baseResourceVersion: row.base_resource_version == null
    ? undefined
    : Number(row.base_resource_version),
  documentVersion: row.document_version == null ? undefined : Number(row.document_version),
  continuationStatus: row.continuation_status ?? undefined,
  continuationLeaseToken: row.continuation_lease_token ?? undefined,
  continuationLeaseExpiresAt: row.continuation_lease_expires_at ?? undefined,
  continuationAttemptCount: row.continuation_attempt_count ?? undefined,
  continuationError: row.continuation_error ?? undefined,
  continuationMessageId: row.continuation_message_id ?? undefined,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

const mapFile = (row: Record<string, any>): LessonFileRecord => ({
  id: row.id, ownerId: row.owner_id, notebookId: row.notebook_id,
  lessonBlueprintId: row.lesson_blueprint_id ?? undefined,
  title: row.title, type: row.type, image: row.image ?? undefined,
  document: lessonPlanSchema.parse(row.document), documentVersion: row.document_version,
  contextProfile: lessonContextProfileSchema.parse(row.context_profile ?? {}),
  pageCount: row.page_count, updatedAt: row.updated_at,
});

const mapNotebook = (row: Record<string, any>): NotebookRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  title: row.title,
  className: row.class_name,
  year: row.year,
  subject: row.subject,
  stage: row.stage ?? "",
  grade: row.grade ?? "",
  edition: row.edition ?? "",
  tone: row.tone ?? "teal",
  updatedAt: row.updated_at,
});


const mapDirectClassroomPresentation = (
  row: Record<string, any>,
): DirectClassroomPresentationRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  notebookId: row.notebook_id,
  lessonFileId: row.lesson_file_id,
  title: row.title,
  theme: row.theme,
  sourceDocumentVersion: Number(row.source_document_version),
  sourceDocument: lessonPlanSchema.parse(row.source_document),
  dashiGoal: dashiGoalSchema.safeParse(row.outline).data ?? null,
  delivery: row.delivery === "native-dashi" ? "native-dashi" : "legacy-static",
  storageKey: row.storage_key,
  mediaType: row.media_type,
  byteSize: Number(row.byte_size),
  checksum: row.checksum,
  idempotencyKey: row.idempotency_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapClassroomPresentationGeneration = (
  row: Record<string, any>,
): ClassroomPresentationGeneration => ({
  id: row.id,
  ownerId: row.owner_id,
  notebookId: row.notebook_id,
  lessonFileId: row.lesson_file_id,
  sourceDocumentVersion: Number(row.source_document_version),
  sourceDocument: lessonPlanSchema.parse(row.source_document),
  lessonTitle: row.lesson_title,
  subject: row.subject,
  gradeLevel: row.grade_level,
  learnerProfile: row.learner_profile,
  lessonDurationMinutes: Number(row.lesson_duration_minutes),
  goal: dashiGoalSchema.safeParse(row.storyboard).data ?? null,
  status: row.status,
  presentationId: row.presentation_id,
  errorCode: row.error_code,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
});




export class SupabaseLessonRepository implements LessonRepository {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async importNotebookGraph(ownerId: string, notebooks: ImportedNotebook[]) {
    const result = await this.client.rpc("import_lessonup_notebooks", {
      p_owner_id: ownerId,
      p_notebooks: notebooks,
    });
    return unwrap(result as any) as { imported: number };
  }

  async listNotebooks(ownerId: string) {
    const [notebooks, files] = await Promise.all([
      this.client.from("notebooks").select("*")
        .eq("owner_id", ownerId).order("updated_at", { ascending: false }),
      this.client.from("lesson_files")
        .select("id,owner_id,notebook_id,lesson_blueprint_id,title,type,image,document,document_version,page_count,updated_at")
        .eq("owner_id", ownerId).order("updated_at", { ascending: false }),
    ]);
    if (notebooks.error) throw new Error(notebooks.error.message);
    if (files.error) throw new Error(files.error.message);
    const mappedFiles = (files.data ?? []).map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      notebookId: row.notebook_id,
      lessonBlueprintId: row.lesson_blueprint_id ?? undefined,
      title: row.title,
      type: row.type,
      image: row.image ?? undefined,
      preview: createLessonPlanPreview(lessonPlanSchema.parse(row.document)),
      documentVersion: row.document_version,
      pageCount: row.page_count,
      updatedAt: row.updated_at,
    }));
    const filesByNotebook = new Map<string, typeof mappedFiles>();
    for (const file of mappedFiles) {
      const grouped = filesByNotebook.get(file.notebookId);
      if (grouped) grouped.push(file);
      else filesByNotebook.set(file.notebookId, [file]);
    }
    return (notebooks.data ?? []).map((row) => {
      const notebook = mapNotebook(row);
      return {
        ...notebook,
        files: filesByNotebook.get(notebook.id) ?? [],
      };
    });
  }

  async createNotebook(ownerId: string, input: Parameters<LessonRepository["createNotebook"]>[1]) {
    const result = await this.client.from("notebooks").insert({
      owner_id: ownerId,
      id: crypto.randomUUID(),
      title: input.title,
      class_name: input.className,
      year: input.year,
      subject: input.subject,
      stage: input.stage ?? "",
      grade: input.grade ?? "",
      edition: input.edition ?? "",
      tone: input.tone,
    }).select("*").single();
    return mapNotebook(unwrap(result as any));
  }

  async updateNotebook(
    ownerId: string,
    notebookId: string,
    patch: Parameters<LessonRepository["updateNotebook"]>[2],
  ) {
    const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.className !== undefined) values.class_name = patch.className;
    if (patch.year !== undefined) values.year = patch.year;
    if (patch.subject !== undefined) values.subject = patch.subject;
    if (patch.stage !== undefined) values.stage = patch.stage;
    if (patch.grade !== undefined) values.grade = patch.grade;
    if (patch.edition !== undefined) values.edition = patch.edition;
    if (patch.tone !== undefined) values.tone = patch.tone;
    const result = await this.client.from("notebooks").update(values)
      .eq("owner_id", ownerId).eq("id", notebookId).select("*").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("notebook_not_found");
    return mapNotebook(result.data);
  }

  async deleteNotebook(ownerId: string, notebookId: string) {
    const result = await this.client.from("notebooks").delete()
      .eq("owner_id", ownerId).eq("id", notebookId).select("id").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("notebook_not_found");
  }

  async getNotebook(ownerId: string, notebookId: string) {
    const result = await this.client.from("notebooks").select("*")
      .eq("owner_id", ownerId).eq("id", notebookId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) return null;
    return mapNotebook(result.data);
  }

  async createLessonFile(
    ownerId: string,
    input: Parameters<LessonRepository["createLessonFile"]>[1],
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    const result = await this.client.rpc("create_lesson_file", {
      p_owner_id: ownerId,
      p_file_id: crypto.randomUUID(),
      p_notebook_id: input.notebookId,
      p_title: input.title,
      p_type: input.type,
      p_image: input.image ?? null,
      p_document: input.document,
      p_page_count: input.pageCount,
      p_context_profile: input.contextProfile ?? {},
      p_lesson_blueprint_id: input.lessonBlueprintId ?? null,
      p_idempotency_key: `create:${idempotencyKey}`,
    });
    return {
      ...mapFile(unwrap(result as any)),
      lessonBlueprintId: input.lessonBlueprintId,
    };
  }

  async updateLessonFile(
    ownerId: string,
    fileId: string,
    patch: Parameters<LessonRepository["updateLessonFile"]>[2],
  ) {
    const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.type !== undefined) values.type = patch.type;
    if (patch.image !== undefined) values.image = patch.image;
    if (patch.contextProfile !== undefined) values.context_profile = patch.contextProfile;
    const result = await this.client.from("lesson_files").update(values)
      .eq("owner_id", ownerId).eq("id", fileId).select("*").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("lesson_file_not_found");
    return mapFile(result.data);
  }

  async deleteLessonFile(ownerId: string, fileId: string) {
    const result = await this.client.from("lesson_files").delete()
      .eq("owner_id", ownerId).eq("id", fileId).select("id").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("lesson_file_not_found");
  }

  async getLessonFile(ownerId: string, fileId: string) {
    const result = await this.client.from("lesson_files").select("*")
      .eq("owner_id", ownerId).eq("id", fileId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapFile(result.data) : null;
  }

  async getLessonDesignBasis(ownerId: string, lessonFileId: string) {
    const result = await this.client.rpc("lesson_design_basis_snapshot", {
      p_owner_id: ownerId,
      p_lesson_file_id: lessonFileId,
    });
    if (result.error) throw new Error(result.error.message);
    return result.data
      ? mapLessonDesignBasisAggregate(result.data as Record<string, any>)
      : null;
  }

  async applyManualLessonDesignBasisPatch(
    ownerId: string,
    patch: LessonDesignBasisPatch,
    idempotencyKey: string,
  ) {
    const result = await this.client.rpc("apply_manual_lesson_design_basis_patch", {
      p_owner_id: ownerId,
      p_basis_id: patch.basisId,
      p_patch: patch,
      p_idempotency_key: idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return mapLessonDesignBasisAggregate(result.data as Record<string, any>);
  }

  async applyApprovedLessonDesignBasisPatch(args: {
    ownerId: string;
    approvalId: string;
    idempotencyKey: string;
  }) {
    const result = await this.client.rpc("apply_approved_lesson_design_basis_patch", {
      p_owner_id: args.ownerId,
      p_approval_id: args.approvalId,
      p_idempotency_key: args.idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return mapLessonDesignBasisAggregate(result.data as Record<string, any>);
  }

  async saveLessonDocument(args: Parameters<LessonRepository["saveLessonDocument"]>[0]) {
    const result = await this.client.rpc("save_lesson_document", {
      p_owner_id: args.ownerId, p_file_id: args.fileId, p_base_version: args.baseVersion,
      p_document: args.document, p_page_count: args.pageCount, p_source: args.source,
      p_run_id: args.runId ?? null, p_idempotency_key: args.idempotencyKey,
    });
    return mapFile(unwrap(result as any));
  }

  async updateLessonPageCount(args: Parameters<LessonRepository["updateLessonPageCount"]>[0]) {
    const result = await this.client.from("lesson_files")
      .update({ page_count: args.pageCount, updated_at: new Date().toISOString() })
      .eq("owner_id", args.ownerId)
      .eq("id", args.fileId)
      .eq("document_version", args.documentVersion)
      .select("*")
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (result.data) return mapFile(result.data);
    const current = await this.getLessonFile(args.ownerId, args.fileId);
    if (!current) throw new Error("lesson_file_not_found");
    throw new Error("stale_document");
  }

  async applyApprovedPatch(args: Parameters<LessonRepository["applyApprovedPatch"]>[0]) {
    const result = await this.client.rpc("apply_approved_document_patch", {
      p_owner_id: args.ownerId, p_approval_id: args.approvalId,
      p_idempotency_key: args.idempotencyKey,
    });
    return mapFile(unwrap(result as any));
  }

  async applyApprovedSemesterFrameworkPatch(
    args: Parameters<LessonRepository["applyApprovedSemesterFrameworkPatch"]>[0],
  ) {
    const result = await this.client.rpc("apply_approved_semester_framework_patch", {
      p_owner_id: args.ownerId,
      p_approval_id: args.approvalId,
      p_idempotency_key: args.idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return mapSemesterFrameworkAggregate(result.data as Record<string, any>);
  }

  async listThreads(
    ownerId: string,
    resource: string | AgentResourceRef,
    includeArchived = false,
  ) {
    const scope = typeof resource === "string"
      ? { resourceType: "lesson_file" as const, lessonFileId: resource }
      : resource;
    let query = this.client.from("agent_threads").select("*")
      .eq("owner_id", ownerId)
      .eq("resource_type", scope.resourceType)
      .is("deleted_at", null);
    query = scope.resourceType === "lesson_file"
      ? query.eq("lesson_file_id", scope.lessonFileId)
      : query.eq("semester_framework_id", scope.semesterFrameworkId);
    if (!includeArchived) query = query.is("archived_at", null);
    const result = await query.order("updated_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapThread);
  }

  async createThread(ownerId: string, input: CreateThreadInput, idempotencyKey: string = crypto.randomUUID()) {
    const resource: AgentResourceRef = input.resourceType === "semester_framework"
      ? { resourceType: "semester_framework", semesterFrameworkId: input.semesterFrameworkId }
      : { resourceType: "lesson_file", lessonFileId: input.lessonFileId };
    const result = await this.client.rpc("create_agent_resource_thread", {
      p_owner_id: ownerId,
      p_thread_id: crypto.randomUUID(),
      p_branch_id: crypto.randomUUID(),
      p_notebook_id: input.notebookId,
      p_resource_type: resource.resourceType,
      p_lesson_file_id: resource.resourceType === "lesson_file" ? resource.lessonFileId : null,
      p_semester_framework_id: resource.resourceType === "semester_framework"
        ? resource.semesterFrameworkId
        : null,
      p_title: input.title ?? "新会话",
      p_idempotency_key: idempotencyKey,
    });
    const created = unwrap(result as any) as { thread: Record<string, any>; branch: Record<string, any> };
    return { thread: mapThread(created.thread), branch: mapBranch(created.branch) };
  }

  async getThread(ownerId: string, threadId: string) {
    const result = await this.client.from("agent_threads").select("*")
      .eq("owner_id", ownerId).eq("id", threadId).is("deleted_at", null).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapThread(result.data) : null;
  }

  async updateThread(ownerId: string, threadId: string, patch: Partial<AgentThreadRecord>) {
    const payload: Record<string, unknown> = {};
    if (patch.title !== undefined) payload.title = patch.title;
    if (patch.archivedAt !== undefined) payload.archived_at = patch.archivedAt;
    if (patch.deletedAt !== undefined) payload.deleted_at = patch.deletedAt;
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.starterSuggestions !== undefined) payload.starter_suggestions = patch.starterSuggestions;
    if (patch.starterSuggestionsDocumentVersion !== undefined) {
      payload.starter_suggestions_document_version = patch.starterSuggestionsDocumentVersion;
    }
    if (patch.starterSuggestionsResourceVersion !== undefined) {
      payload.starter_suggestions_resource_version = patch.starterSuggestionsResourceVersion;
    }
    const result = await this.client.from("agent_threads").update(payload)
      .eq("owner_id", ownerId).eq("id", threadId).select("*").single();
    return mapThread(unwrap(result as any));
  }

  async createBranch(ownerId: string, threadId: string, parentBranchId?: string, forkedFromMessageId?: string) {
    const result = await this.client.rpc("fork_agent_branch", {
      p_owner_id: ownerId, p_thread_id: threadId,
      p_parent_branch_id: parentBranchId ?? null,
      p_forked_from_message_id: forkedFromMessageId ?? null,
    });
    return mapBranch(unwrap(result as any));
  }

  async listBranches(ownerId: string, threadId: string) {
    const result = await this.client.from("agent_branches").select("*")
      .eq("owner_id", ownerId).eq("thread_id", threadId).order("created_at", { ascending: true });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapBranch);
  }

  async getBranch(ownerId: string, threadId: string, branchId: string) {
    const result = await this.client.from("agent_branches").select("*")
      .eq("owner_id", ownerId).eq("thread_id", threadId).eq("id", branchId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapBranch(result.data) : null;
  }

  async updateBranch(ownerId: string, threadId: string, branchId: string, patch: Partial<AgentBranchRecord>) {
    const payload: Record<string, unknown> = {};
    if (patch.pendingInteraction !== undefined) payload.pending_interaction = patch.pendingInteraction;
    const result = await this.client.from("agent_branches").update(payload)
      .eq("owner_id", ownerId).eq("thread_id", threadId).eq("id", branchId)
      .select("*").single();
    return mapBranch(unwrap(result as any));
  }

  async listMessages(ownerId: string, threadId: string, branchId: string, cursor?: string, limit = 100) {
    let query = this.client.from("agent_messages").select("*")
      .eq("owner_id", ownerId).eq("thread_id", threadId).eq("branch_id", branchId);
    if (cursor) {
      const separator = cursor.lastIndexOf("|");
      if (separator > 0) {
        const createdAt = cursor.slice(0, separator);
        const id = cursor.slice(separator + 1);
        query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`);
      } else {
        query = query.lt("created_at", cursor);
      }
    }
    const result = await query
      .order("sequence", { ascending: false })
      .limit(limit);
    if (result.error) throw new Error(result.error.message);
    const messages = (result.data ?? []).reverse().map(mapMessage);
    const assistantIds = messages.filter((message) => message.role === "assistant").map((message) => message.id);
    if (!assistantIds.length) return messages;
    const runsResult = await this.client.from("agent_runs")
      .select("id,assistant_message_id,status,started_at,completed_at")
      .eq("owner_id", ownerId)
      .in("assistant_message_id", assistantIds)
      .order("started_at", { ascending: false });
    if (runsResult.error) throw new Error(runsResult.error.message);
    const runByMessageId = new Map<string, Record<string, any>>();
    for (const run of runsResult.data ?? []) {
      if (!runByMessageId.has(run.assistant_message_id)) runByMessageId.set(run.assistant_message_id, run);
    }
    const runIds = [...runByMessageId.values()].map((run) => run.id);
    if (!runIds.length) return messages;
    const eventsResult = await this.client.from("agent_events")
      .select("run_id,data,created_at")
      .eq("owner_id", ownerId)
      .in("run_id", runIds)
      .order("created_at", { ascending: true });
    if (eventsResult.error) throw new Error(eventsResult.error.message);
    const eventsByRunId = new Map<string, NormalizedAgentEvent[]>();
    for (const event of eventsResult.data ?? []) {
      const list = eventsByRunId.get(event.run_id) ?? [];
      list.push(event.data as NormalizedAgentEvent);
      eventsByRunId.set(event.run_id, list);
    }
    return messages.map((message) => {
      const run = runByMessageId.get(message.id);
      if (!run) return message;
      const runEvents = eventsByRunId.get(run.id) ?? [];
      const turnPhase = persistedTurnPhaseFromEvents(runEvents, run.status);
      return {
        ...message,
        activities: persistedActivitiesFromEvents(runEvents, run.status),
        turn: {
          runId: run.id,
          status: run.status,
          ...turnPhase,
          startedAt: run.started_at,
          completedAt: run.completed_at ?? undefined,
        },
      };
    });
  }

  async getMessage(ownerId: string, messageId: string) {
    const result = await this.client.from("agent_messages").select("*")
      .eq("owner_id", ownerId).eq("id", messageId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapMessage(result.data) : null;
  }

  async appendMessage(input: Omit<AgentMessageRecord, "id" | "createdAt"> & { id?: string }) {
    if (input.id) {
      const existing = await this.getMessage(input.ownerId, input.id);
      if (existing) {
        if (
          existing.threadId !== input.threadId
          || existing.branchId !== input.branchId
          || existing.role !== input.role
        ) {
          throw new Error("idempotency_conflict");
        }
        return existing;
      }
    }
    const result = await this.client.from("agent_messages").insert({
      id: input.id, owner_id: input.ownerId, thread_id: input.threadId, branch_id: input.branchId,
      role: input.role, content: input.content, status: input.status, sources: input.sources ?? [],
      session_cursor: input.sessionCursor,
    }).select("*").single();
    return mapMessage(unwrap(result as any));
  }

  async updateMessage(ownerId: string, messageId: string, patch: Partial<AgentMessageRecord>) {
    const result = await this.client.from("agent_messages").update({
      content: patch.content, status: patch.status, error: patch.error, sources: patch.sources,
      session_cursor: patch.sessionCursor,
    }).eq("owner_id", ownerId).eq("id", messageId).select("*").single();
    return mapMessage(unwrap(result as any));
  }

  async createRun(input: Omit<AgentRunRecord, "startedAt"> & { startedAt?: string }) {
    const result = await this.client.from("agent_runs").insert({
      id: input.id, owner_id: input.ownerId, thread_id: input.threadId, branch_id: input.branchId,
      model: input.model, status: input.status, capability_plan: input.capabilityPlan,
      agent_definition_version: input.agentDefinitionVersion,
      skill_versions: input.skillVersions,
      attachment_source_ids: input.attachmentSourceIds,
      token_usage: input.tokenUsage,
      provider_cost: input.providerCost,
      lease_token: input.leaseToken,
      lease_expires_at: input.leaseExpiresAt,
      heartbeat_at: input.heartbeatAt,
      cancel_requested_at: input.cancelRequestedAt,
      assistant_message_id: input.assistantMessageId,
      started_at: input.startedAt,
    }).select("*").single();
    return mapRun(unwrap(result as any));
  }

  async getRun(ownerId: string, runId: string) {
    const result = await this.client.from("agent_runs").select("*")
      .eq("owner_id", ownerId).eq("id", runId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapRun(result.data) : null;
  }

  async getLatestRun(ownerId: string, threadId: string, branchId: string) {
    const result = await this.client.from("agent_runs").select("*")
      .eq("owner_id", ownerId).eq("thread_id", threadId).eq("branch_id", branchId)
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapRun(result.data) : null;
  }

  async getLatestCompletedRun(ownerId: string, threadId: string, branchId: string) {
    const result = await this.client.from("agent_runs").select("*")
      .eq("owner_id", ownerId)
      .eq("thread_id", threadId)
      .eq("branch_id", branchId)
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapRun(result.data) : null;
  }

  async updateRun(ownerId: string, runId: string, patch: Partial<AgentRunRecord>) {
    const result = await this.client.from("agent_runs").update({
      status: patch.status, capability_plan: patch.capabilityPlan,
      agent_definition_version: patch.agentDefinitionVersion,
      skill_versions: patch.skillVersions,
      attachment_source_ids: patch.attachmentSourceIds,
      token_usage: patch.tokenUsage,
      provider_cost: patch.providerCost,
      lease_token: patch.leaseToken,
      lease_expires_at: patch.leaseExpiresAt,
      heartbeat_at: patch.heartbeatAt,
      cancel_requested_at: patch.cancelRequestedAt,
      assistant_message_id: patch.assistantMessageId,
      error: patch.error, completed_at: patch.completedAt,
    }).eq("owner_id", ownerId).eq("id", runId).select("*").single();
    return mapRun(unwrap(result as any));
  }

  async heartbeatRun(args: Parameters<LessonRepository["heartbeatRun"]>[0]) {
    const result = await this.client.rpc("heartbeat_agent_run", {
      p_owner_id: args.ownerId,
      p_run_id: args.runId,
      p_lease_token: args.leaseToken,
      p_lease_expires_at: args.leaseExpiresAt,
    });
    return mapRun(unwrap(result as any));
  }

  async settleRun(args: Parameters<LessonRepository["settleRun"]>[0]) {
    const result = await this.client.rpc("settle_agent_run", {
      p_owner_id: args.ownerId,
      p_run_id: args.runId,
      p_lease_token: args.leaseToken,
      p_status: args.status,
      p_token_usage: args.tokenUsage ?? null,
      p_error: args.error ?? null,
      p_message_status: args.messageStatus ?? null,
      p_message_content: args.messageContent ?? null,
      p_message_sources: args.messageSources ?? null,
      p_session_cursor: args.sessionCursor ?? null,
    });
    return mapRun(unwrap(result as any));
  }

  async requestRunCancellation(ownerId: string, runId: string) {
    const result = await this.client.rpc("request_agent_run_cancellation", {
      p_owner_id: ownerId,
      p_run_id: runId,
    });
    return Boolean(unwrap(result as any));
  }

  async recoverExpiredRuns(ownerId: string, threadId?: string) {
    const result = await this.client.rpc("recover_expired_agent_runs", {
      p_owner_id: ownerId,
      p_thread_id: threadId ?? null,
    });
    return Number(unwrap(result as any));
  }

  async appendRunEvent(ownerId: string, runId: string, type: string, data: unknown) {
    const result = await this.client.from("agent_events").insert({
      owner_id: ownerId, run_id: runId, type, data,
    });
    if (result.error) throw new Error(result.error.message);
  }

  async listRunEvents(ownerId: string, runId: string) {
    const result = await this.client.from("agent_events").select("data")
      .eq("owner_id", ownerId).eq("run_id", runId).order("id", { ascending: true });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map((row) => row.data as NormalizedAgentEvent);
  }

  async saveApproval(approval: AgentApprovalRecord) {
    const result = await this.client.from("agent_approvals").insert({
      id: approval.id, owner_id: approval.ownerId, run_id: approval.runId,
      thread_id: approval.threadId, branch_id: approval.branchId, state: approval.state,
      assistant_message_id: approval.assistantMessageId,
      patch: approval.patch, encrypted_run_state: approval.encryptedRunState,
      agent_definition_version: approval.agentDefinitionVersion,
      resource_type: approval.resourceType,
      patch_kind: approval.patchKind,
      lesson_file_id: approval.lessonFileId,
      semester_framework_id: approval.semesterFrameworkId,
      base_resource_version: approval.baseResourceVersion,
      document_version: approval.documentVersion,
      expires_at: approval.expiresAt,
      created_at: approval.createdAt,
    });
    if (result.error) throw new Error(result.error.message);
  }

  async getApproval(ownerId: string, approvalId: string) {
    const result = await this.client.from("agent_approvals").select("*")
      .eq("owner_id", ownerId).eq("id", approvalId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    const row = result.data;
    return row ? mapApproval(row) : null;
  }

  async listApprovals(ownerId: string, threadId: string, branchId: string) {
    const result = await this.client.from("agent_approvals").select("*")
      .eq("owner_id", ownerId).eq("thread_id", threadId).eq("branch_id", branchId)
      .order("created_at", { ascending: true });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapApproval);
  }

  async listPendingApprovals(ownerId: string, threadId: string, branchId: string) {
    const result = await this.client.from("agent_approvals").select("*")
      .eq("owner_id", ownerId).eq("thread_id", threadId).eq("branch_id", branchId)
      .or("state.eq.pending,continuation_status.in.(ready,running)")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapApproval);
  }

  async resolveApproval(ownerId: string, approvalId: string, state: "approved" | "rejected" | "expired") {
    const existing = await this.getApproval(ownerId, approvalId);
    if (!existing) throw new Error("approval_not_found");
    if (existing.state === state) return existing;
    if (existing.state !== "pending") throw new Error("approval_already_resolved");
    const result = await this.client.from("agent_approvals").update({ state })
      .eq("owner_id", ownerId).eq("id", approvalId).eq("state", "pending").select("*").single();
    unwrap(result as any);
    const approval = await this.getApproval(ownerId, approvalId);
    if (!approval) throw new Error("approval_not_found");
    return approval;
  }

  async expireApprovalLifecycle(ownerId: string, approvalId: string) {
    const result = await this.client.rpc("expire_agent_approval_lifecycle", {
      p_owner_id: ownerId,
      p_approval_id: approvalId,
    });
    return mapApproval(unwrap(result as any));
  }

  async decideApproval(args: {
    ownerId: string;
    approvalId: string;
    approved: boolean;
    encryptedRunState: string;
  }) {
    const result = await this.client.rpc("decide_agent_approval", {
      p_owner_id: args.ownerId,
      p_approval_id: args.approvalId,
      p_approved: args.approved,
      p_encrypted_run_state: args.encryptedRunState,
    });
    const payload = unwrap(result as any) as {
      approval: Record<string, any>;
      file: Record<string, any> | null;
      framework: Record<string, any> | null;
      basis: Record<string, any> | null;
    };
    return {
      approval: mapApproval(payload.approval),
      file: payload.file ? mapFile(payload.file) : null,
      framework: payload.framework
        ? mapSemesterFrameworkAggregate(payload.framework)
        : null,
      basis: payload.basis ? mapLessonDesignBasisAggregate(payload.basis) : null,
    };
  }

  async claimApprovalContinuation(args: {
    ownerId: string;
    approvalId: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }) {
    const result = await this.client.rpc("claim_agent_approval_continuation", {
      p_owner_id: args.ownerId,
      p_approval_id: args.approvalId,
      p_lease_token: args.leaseToken,
      p_lease_expires_at: args.leaseExpiresAt,
    });
    return mapApproval(unwrap(result as any));
  }

  async finishApprovalContinuation(args: {
    ownerId: string;
    approvalId: string;
    leaseToken: string;
    status: "ready" | "completed";
    error?: string;
  }) {
    const result = await this.client.rpc("finish_agent_approval_continuation", {
      p_owner_id: args.ownerId,
      p_approval_id: args.approvalId,
      p_lease_token: args.leaseToken,
      p_status: args.status,
      p_error: args.error ?? null,
    });
    return mapApproval(unwrap(result as any));
  }

  async settleApprovalContinuation(args: Parameters<LessonRepository["settleApprovalContinuation"]>[0]) {
    const result = await this.client.rpc("settle_agent_approval_continuation", {
      p_owner_id: args.ownerId,
      p_approval_id: args.approvalId,
      p_lease_token: args.leaseToken,
      p_outcome: args.outcome,
      p_assistant_message_id: args.assistantMessageId ?? null,
      p_content: args.content ?? null,
      p_sources: args.sources ?? null,
      p_session_items: args.sessionItems ?? null,
      p_session_cursor: args.sessionCursor ?? null,
      p_token_usage: args.tokenUsage ?? null,
      p_encrypted_run_state: args.encryptedRunState ?? null,
      p_error: args.error ?? null,
    });
    return mapApproval(unwrap(result as any));
  }

  async getSessionItems(ownerId: string, threadId: string, branchId: string, limit?: number) {
    let query = this.client.from("agent_session_items").select("item")
      .eq("owner_id", ownerId).eq("thread_id", threadId).eq("branch_id", branchId)
      .order("sequence", { ascending: !limit });
    if (limit) query = query.limit(limit);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    const rows = limit ? (result.data ?? []).reverse() : (result.data ?? []);
    return rows.map((row) => row.item as AgentInputItem);
  }

  async getSessionItemsAfter(
    ownerId: string,
    threadId: string,
    branchId: string,
    afterCursor: number,
    limit?: number,
  ) {
    let query = this.client.from("agent_session_items").select("item")
      .eq("owner_id", ownerId)
      .eq("thread_id", threadId)
      .eq("branch_id", branchId)
      .gt("sequence", afterCursor)
      .order("sequence", { ascending: !limit });
    if (limit) query = query.limit(limit);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    const rows = limit ? (result.data ?? []).reverse() : (result.data ?? []);
    return rows.map((row) => row.item as AgentInputItem);
  }

  async getSessionItemCount(ownerId: string, threadId: string, branchId: string) {
    const result = await this.client.from("agent_session_items")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", ownerId)
      .eq("thread_id", threadId)
      .eq("branch_id", branchId);
    if (result.error) throw new Error(result.error.message);
    return result.count ?? 0;
  }

  async addSessionItems(
    ownerId: string,
    threadId: string,
    branchId: string,
    items: AgentInputItem[],
    idempotencyKey?: string,
  ) {
    const result = await this.client.rpc("append_agent_session_items", {
      p_owner_id: ownerId,
      p_thread_id: threadId,
      p_branch_id: branchId,
      p_items: items,
      p_idempotency_key: idempotencyKey ?? null,
    });
    if (result.error) throw new Error(result.error.message);
  }

  async replaceSessionItems(
    ownerId: string,
    threadId: string,
    branchId: string,
    items: AgentInputItem[],
  ) {
    const result = await this.client.rpc("replace_agent_session_items", {
      p_owner_id: ownerId,
      p_thread_id: threadId,
      p_branch_id: branchId,
      p_items: items,
    });
    if (result.error) throw new Error(result.error.message);
  }

  async popSessionItem(ownerId: string, threadId: string, branchId: string) {
    const result = await this.client.rpc("pop_agent_session_item", {
      p_owner_id: ownerId, p_thread_id: threadId, p_branch_id: branchId,
    });
    if (result.error) throw new Error(result.error.message);
    return result.data as AgentInputItem | undefined;
  }

  async clearSession(ownerId: string, threadId: string, branchId: string) {
    const result = await this.client.from("agent_session_items").delete()
      .eq("owner_id", ownerId).eq("thread_id", threadId).eq("branch_id", branchId);
    if (result.error) throw new Error(result.error.message);
  }

  async getAgentRuntimeSession(
    ownerId: string,
    threadId: string,
    branchId: string,
    runtime: AgentRuntimeName,
  ) {
    const result = await this.client.from("agent_runtime_sessions")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("thread_id", threadId)
      .eq("branch_id", branchId)
      .eq("runtime", runtime)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapRuntimeSession(result.data) : null;
  }

  async saveAgentRuntimeSession(args: {
    ownerId: string;
    threadId: string;
    branchId: string;
    runtime: AgentRuntimeName;
    expectedRevision: number;
    messages: unknown[];
  }) {
    const result = await this.client.rpc("save_agent_runtime_session", {
      p_owner_id: args.ownerId,
      p_thread_id: args.threadId,
      p_branch_id: args.branchId,
      p_runtime: args.runtime,
      p_expected_revision: args.expectedRevision,
      p_messages: args.messages,
    });
    return mapRuntimeSession(unwrap(result as any));
  }

  async getThreadMemory(ownerId: string, threadId: string, branchId: string) {
    const result = await this.client.from("agent_thread_memories")
      .select("summary,summary_cursor")
      .eq("owner_id", ownerId).eq("thread_id", threadId).eq("branch_id", branchId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data
      ? { summary: result.data.summary, cursor: Number(result.data.summary_cursor) }
      : null;
  }

  async saveThreadMemory(ownerId: string, threadId: string, branchId: string, summary: string, cursor: number) {
    const result = await this.client.from("agent_thread_memories").upsert({
      owner_id: ownerId, thread_id: threadId, branch_id: branchId, summary, summary_cursor: cursor,
    }, { onConflict: "owner_id,thread_id,branch_id" });
    if (result.error) throw new Error(result.error.message);
  }

  async searchKnowledge(ownerId: string, scopes: string[], query: string, limit: number, embedding?: number[]) {
    const result = await this.client.rpc("search_knowledge_hybrid", {
      p_owner_id: ownerId, p_scopes: scopes, p_query: query,
      p_query_embedding: embedding ?? null, p_limit: limit,
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []) as KnowledgeResult[];
  }

  async searchCurriculumStandards(input: {
    query: string;
    subject: string;
    stage?: string;
    grade?: string;
    limit: number;
    embedding?: number[];
  }) {
    const result = await this.client.rpc("search_curriculum_standards", {
      p_query: input.query,
      p_query_embedding: input.embedding ?? null,
      p_subject: input.subject,
      p_stage: input.stage ?? null,
      p_grade: input.grade ?? null,
      p_limit: input.limit,
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []) as KnowledgeResult[];
  }

  async getPublishedCurriculumStandardFingerprint() {
    const result = await this.client.from("curriculum_standard_releases")
      .select("id,release_key,published_at,updated_at")
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) return null;
    return [
      result.data.id,
      result.data.release_key,
      result.data.updated_at ?? result.data.published_at,
    ].join(":");
  }

  async getCurriculumStandardSearchCache(input: {
    contextFingerprint: string;
    querySha256: string;
    limit: number;
  }) {
    const result = await this.client.from("curriculum_standard_query_cache")
      .select("context_fingerprint,query_sha256,result_limit,results,updated_at")
      .eq("context_fingerprint", input.contextFingerprint)
      .eq("query_sha256", input.querySha256)
      .eq("result_limit", input.limit)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) return null;
    return {
      contextFingerprint: result.data.context_fingerprint,
      querySha256: result.data.query_sha256,
      limit: result.data.result_limit,
      results: result.data.results as KnowledgeResult[],
      updatedAt: result.data.updated_at,
    };
  }

  async saveCurriculumStandardSearchCache(input: {
    contextFingerprint: string;
    querySha256: string;
    limit: number;
    results: KnowledgeResult[];
  }) {
    const result = await this.client.from("curriculum_standard_query_cache").upsert({
      context_fingerprint: input.contextFingerprint,
      query_sha256: input.querySha256,
      result_limit: input.limit,
      results: input.results,
      updated_at: new Date().toISOString(),
    }, { onConflict: "context_fingerprint,query_sha256,result_limit" })
      .select("context_fingerprint,query_sha256,result_limit,results,updated_at")
      .single();
    if (result.error) throw new Error(result.error.message);
    return {
      contextFingerprint: result.data.context_fingerprint,
      querySha256: result.data.query_sha256,
      limit: result.data.result_limit,
      results: result.data.results as KnowledgeResult[],
      updatedAt: result.data.updated_at,
    };
  }

  async getKnowledgePassage(ownerId: string, scopes: string[], chunkId: string) {
    const result = await this.client.rpc("get_scoped_knowledge_passage", {
      p_owner_id: ownerId, p_scopes: scopes, p_chunk_id: chunkId,
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data?.[0] ?? null) as KnowledgeResult | null;
  }

  async getKnowledgeSourcePassages(ownerId: string, scopes: string[], sourceId: string, limit: number) {
    const result = await this.client.rpc("get_scoped_knowledge_source_passages", {
      p_owner_id: ownerId,
      p_scopes: scopes,
      p_source_id: sourceId,
      p_limit: limit,
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []) as KnowledgeResult[];
  }

  async listProjectSources(ownerId: string, scopes: string[]) {
    const result = await this.client.rpc("list_scoped_knowledge_sources", {
      p_owner_id: ownerId, p_scopes: scopes,
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []) as SourceRef[];
  }

  async attachKnowledgeSources(
    ownerId: string,
    lessonFileId: string,
    messageId: string,
    sourceIds: string[],
  ) {
    if (!sourceIds.length) return [];
    const result = await this.client.rpc("attach_knowledge_sources_to_message", {
      p_owner_id: ownerId,
      p_lesson_file_id: lessonFileId,
      p_message_id: messageId,
      p_source_ids: [...new Set(sourceIds)],
    });
    if (result.error) throw new Error(
      result.error.message.includes("knowledge_attachment_unavailable")
        ? "knowledge_attachment_unavailable"
        : result.error.message,
    );
    return (result.data ?? []) as SourceRef[];
  }

  async recordRunEvidence(
    ownerId: string,
    runId: string,
    kind: Parameters<LessonRepository["recordRunEvidence"]>[2],
    sources: SourceRef[],
  ) {
    if (!sources.length) return;
    const result = await this.client.from("agent_run_evidence").upsert(
      uniqueRunEvidenceSources(sources).map((source) => ({
        owner_id: ownerId,
        run_id: runId,
        kind,
        source_id: source.id,
        evidence_key: runEvidenceIdentity(source),
        source,
      })),
      { onConflict: "owner_id,run_id,kind,evidence_key" },
    );
    if (result.error) throw new Error(result.error.message);
  }

  async listRunEvidence(ownerId: string, runId: string) {
    const result = await this.client.from("agent_run_evidence").select("*")
      .eq("owner_id", ownerId)
      .eq("run_id", runId)
      .order("created_at", { ascending: true });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map((row): AgentRunEvidenceRecord => ({
      ownerId: row.owner_id,
      runId: row.run_id,
      kind: row.kind,
      source: row.source,
      createdAt: row.created_at,
    }));
  }

  async filterCurrentCurriculumStandardSources(sources: SourceRef[]) {
    const candidates = sources.filter((source) => source.id && source.chunkId);
    if (!candidates.length) return [];
    const releases = await this.client.from("curriculum_standard_releases")
      .select("id")
      .eq("status", "published");
    if (releases.error) throw new Error(releases.error.message);
    const releaseIds = (releases.data ?? []).map((release) => release.id);
    if (!releaseIds.length) return [];
    const sourceIds = [...new Set(candidates.map((source) => source.id))];
    const documents = await this.client.from("curriculum_standard_documents")
      .select("knowledge_source_id")
      .in("release_id", releaseIds)
      .in("knowledge_source_id", sourceIds);
    if (documents.error) throw new Error(documents.error.message);
    const publishedSourceIds = new Set(
      (documents.data ?? []).map((document) => String(document.knowledge_source_id)),
    );
    if (!publishedSourceIds.size) return [];
    const chunkIds = [...new Set(candidates.map((source) => source.chunkId!))];
    const chunks = await this.client.from("knowledge_chunks")
      .select("source_id,stable_chunk_id")
      .in("source_id", [...publishedSourceIds])
      .in("stable_chunk_id", chunkIds);
    if (chunks.error) throw new Error(chunks.error.message);
    const publishedChunks = new Set(
      (chunks.data ?? []).map((chunk) => `${chunk.source_id}:${chunk.stable_chunk_id}`),
    );
    return candidates.filter((source) => (
      publishedChunks.has(`${source.id}:${source.chunkId}`)
    ));
  }

  async createSemesterFramework(
    ownerId: string,
    notebookId: string,
    input: CreateSemesterFrameworkInput,
    idempotencyKey: string,
  ) {
    const result = await this.client.rpc("create_semester_framework", {
      p_owner_id: ownerId,
      p_framework_id: crypto.randomUUID(),
      p_notebook_id: notebookId,
      p_textbook_id: input.textbookId,
      p_title: input.title,
      p_term: input.term,
      p_start_date: input.startDate ?? null,
      p_total_weeks: input.totalWeeks,
      p_weekly_periods: input.weeklyPeriods,
      p_lesson_duration_minutes: input.lessonDurationMinutes,
      p_capacity_ratio: input.capacityRatio,
      p_planning_horizon_weeks: input.planningHorizonWeeks,
      p_context_profile: input.contextProfile,
      p_idempotency_key: idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return mapSemesterFrameworkAggregate(result.data as Record<string, any>);
  }

  async listSemesterFrameworks(ownerId: string, notebookId: string) {
    const result = await this.client
      .from("semester_frameworks")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("notebook_id", notebookId)
      .order("updated_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapSemesterFramework);
  }

  async applyManualSemesterFrameworkPatch(
    ownerId: string,
    patch: SemesterFrameworkPatch,
    idempotencyKey: string,
  ) {
    const result = await this.client.rpc("apply_manual_semester_framework_patch", {
      p_owner_id: ownerId,
      p_framework_id: patch.frameworkId,
      p_patch: patch,
      p_idempotency_key: idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return mapSemesterFrameworkAggregate(result.data as Record<string, any>);
  }

  async createLessonBlueprint(
    ownerId: string,
    frameworkId: string,
    input: CreateLessonBlueprintInput,
    idempotencyKey: string,
  ) {
    const aggregate = await this.getSemesterFramework(ownerId, frameworkId);
    if (!aggregate) throw new Error("semester_framework_not_found");
    const result = await this.client.rpc("create_lesson_blueprint", {
      p_owner_id: ownerId,
      p_framework_id: frameworkId,
      p_blueprint_id: crypto.randomUUID(),
      p_input: {
        ...input,
        plannedMinutes: aggregate.framework.lessonDurationMinutes,
      },
      p_idempotency_key: idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return mapSemesterFrameworkAggregate(result.data as Record<string, any>);
  }

  async updateLessonBlueprint(
    ownerId: string,
    frameworkId: string,
    blueprintId: string,
    input: UpdateLessonBlueprintInput,
    idempotencyKey: string,
  ) {
    const result = await this.client.rpc("update_lesson_blueprint", {
      p_owner_id: ownerId,
      p_framework_id: frameworkId,
      p_blueprint_id: blueprintId,
      p_input: input,
      p_idempotency_key: idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return mapSemesterFrameworkAggregate(result.data as Record<string, any>);
  }

  async deleteLessonBlueprint(
    ownerId: string,
    frameworkId: string,
    blueprintId: string,
    input: DeleteLessonBlueprintInput,
    idempotencyKey: string,
  ) {
    const result = await this.client.rpc("delete_lesson_blueprint", {
      p_owner_id: ownerId,
      p_framework_id: frameworkId,
      p_blueprint_id: blueprintId,
      p_expected_version: input.expectedVersion,
      p_idempotency_key: idempotencyKey,
    });
    if (result.error) throw new Error(result.error.message);
    return mapSemesterFrameworkAggregate(result.data as Record<string, any>);
  }

  async getSemesterFramework(ownerId: string, frameworkId: string) {
    const result = await this.client.rpc("semester_framework_snapshot", {
      p_owner_id: ownerId,
      p_framework_id: frameworkId,
    });
    if (result.error) throw new Error(result.error.message);
    return result.data
      ? mapSemesterFrameworkAggregate(result.data as Record<string, any>)
      : null;
  }

  private async deriveSuggestedFrameworkContinuity(
    aggregate: SemesterFrameworkAggregate,
  ): Promise<FrameworkContinuityCandidateRecord[]> {
    const semanticReleaseId = aggregate.framework.semanticReleaseId;
    if (!semanticReleaseId) return [];
    const [nodes, mappingsResult, revisionsResult] = await Promise.all([
      this.listCurriculumNodes({
        textbookId: aggregate.framework.textbookId,
        catalogReleaseId: aggregate.framework.catalogReleaseId,
        maxLevel: 8,
      }),
      this.client.from("curriculum_node_semantics")
        .select("node_id,sequence_no,semantic_entity_id,confidence")
        .eq("release_id", semanticReleaseId)
        .eq("textbook_id", aggregate.framework.textbookId)
        .eq("review_state", "approved"),
      this.client.from("curriculum_semantic_entity_revisions")
        .select("semantic_entity_id,canonical_name,confidence")
        .eq("release_id", semanticReleaseId)
        .eq("review_state", "approved"),
    ]);
    if (mappingsResult.error) throw new Error(mappingsResult.error.message);
    if (revisionsResult.error) throw new Error(revisionsResult.error.message);
    const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
    const unitByRootNode = new Map(aggregate.units.map((unit) => [
      unit.curriculumNodeId,
      unit,
    ]));
    const unitForNode = (nodeId: string) => {
      let node = nodeById.get(nodeId);
      const visited = new Set<string>();
      while (node && !visited.has(node.nodeId)) {
        visited.add(node.nodeId);
        const unit = unitByRootNode.get(node.nodeId);
        if (unit) return unit;
        node = node.parentId ? nodeById.get(node.parentId) : undefined;
      }
      return undefined;
    };
    const revisionById = new Map((revisionsResult.data ?? []).map((revision) => [
      String(revision.semantic_entity_id),
      revision,
    ]));
    const occurrenceByUnitAndPoint = new Map<string, {
      unitId: string;
      unitSortNo: number;
      nodeId: string;
      sequenceNo: number;
      entityId: string;
      pointName: string;
      confidence: number;
    }>();
    for (const mapping of mappingsResult.data ?? []) {
      const unit = unitForNode(String(mapping.node_id));
      const revision = revisionById.get(String(mapping.semantic_entity_id));
      if (!unit || !revision) continue;
      const key = `${unit.id}:${mapping.semantic_entity_id}`;
      const occurrence = {
        unitId: unit.id,
        unitSortNo: unit.sortNo,
        nodeId: String(mapping.node_id),
        sequenceNo: Number(mapping.sequence_no ?? 0),
        entityId: String(mapping.semantic_entity_id),
        pointName: String(revision.canonical_name),
        confidence: Math.min(
          Number(mapping.confidence ?? 1),
          Number(revision.confidence ?? 1),
        ),
      };
      const existing = occurrenceByUnitAndPoint.get(key);
      if (!existing || occurrence.sequenceNo < existing.sequenceNo) {
        occurrenceByUnitAndPoint.set(key, occurrence);
      }
    }
    const timestamp = new Date().toISOString();
    return deriveFrameworkContinuity({
      occurrences: [...occurrenceByUnitAndPoint.values()],
      relations: [],
      includeLexicalCandidates: true,
    }).filter((draft) => draft.evidenceKind === "lexical_similarity")
      .map((draft) => ({
        id: `lexical-${draft.fingerprint}`,
        frameworkId: aggregate.framework.id,
        derivedFromFrameworkVersion: aggregate.framework.version,
        ...draft,
        decision: "candidate" as const,
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
  }

  private async loadContinuityDecisions(ownerId: string, frameworkId: string) {
    const result = await this.client
      .from("framework_continuity_decisions")
      .select("fingerprint, decision")
      .eq("owner_id", ownerId)
      .eq("framework_id", frameworkId);
    if (result.error) throw new Error(result.error.message);
    return new Map(
      (result.data ?? []).map((row) => [
        String(row.fingerprint),
        row.decision as FrameworkContinuityCandidateRecord["decision"],
      ]),
    );
  }

  private async withContinuityDecisions(
    ownerId: string,
    frameworkId: string,
    candidates: FrameworkContinuityCandidateRecord[],
  ) {
    const decisions = await this.loadContinuityDecisions(ownerId, frameworkId);
    return applyContinuityDecisions(candidates, decisions);
  }

  async getSemesterFrameworkContinuity(ownerId: string, frameworkId: string) {
    const framework = await this.getSemesterFramework(ownerId, frameworkId);
    if (!framework) throw new Error("semester_framework_not_found");
    const result = await this.client
      .from("framework_continuity_candidates")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("framework_id", frameworkId)
      .eq("active", true)
      .order("target_unit_id", { ascending: true })
      .order("direction", { ascending: true })
      .order("confidence", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    const verified = (result.data ?? []).map(mapFrameworkContinuityCandidate);
    const suggested = await this.deriveSuggestedFrameworkContinuity(framework);
    const candidates = await this.withContinuityDecisions(
      ownerId,
      frameworkId,
      mergeFrameworkContinuityCandidates(verified, suggested),
    );
    return {
      status: framework.framework.semanticReleaseId
        ? "available" as const
        : "semantic_release_unavailable" as const,
      frameworkVersion: framework.framework.version,
      candidates,
    };
  }

  async refreshSemesterFrameworkContinuity(ownerId: string, frameworkId: string) {
    const result = await this.client.rpc("refresh_semester_framework_continuity", {
      p_owner_id: ownerId,
      p_framework_id: frameworkId,
    });
    if (result.error) throw new Error(result.error.message);
    const payload = result.data as Record<string, any>;
    const framework = await this.getSemesterFramework(ownerId, frameworkId);
    if (!framework) throw new Error("semester_framework_not_found");
    const verified = (payload.candidates ?? []).map(mapFrameworkContinuityCandidate);
    const suggested = await this.deriveSuggestedFrameworkContinuity(framework);
    const candidates = await this.withContinuityDecisions(
      ownerId,
      frameworkId,
      mergeFrameworkContinuityCandidates(verified, suggested),
    );
    return {
      status: payload.status,
      frameworkVersion: Number(payload.frameworkVersion),
      candidates,
    };
  }

  async setSemesterFrameworkContinuityDecision(
    ownerId: string,
    frameworkId: string,
    input: SetFrameworkContinuityDecisionInput,
  ) {
    const continuity = await this.getSemesterFrameworkContinuity(ownerId, frameworkId);
    const fingerprint = input.fingerprint
      ?? continuityFingerprintFromCandidateId(input.candidateId ?? "")
      ?? continuity.candidates.find((candidate) => candidate.id === input.candidateId)?.fingerprint;
    if (!fingerprint) throw new Error("continuity_candidate_not_found");
    const candidate = continuity.candidates.find((item) => item.fingerprint === fingerprint);
    if (!candidate) throw new Error("continuity_candidate_not_found");

    const upsert = await this.client.from("framework_continuity_decisions").upsert({
      owner_id: ownerId,
      framework_id: frameworkId,
      fingerprint,
      decision: input.decision,
      note: input.note?.trim() ?? "",
      target_unit_id: candidate.targetUnitId,
      direction: candidate.direction,
      current_entity_id: candidate.currentEntityId,
      related_entity_id: candidate.relatedEntityId,
      related_unit_id: candidate.relatedUnitId,
      evidence_kind: candidate.evidenceKind,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_id,framework_id,fingerprint" });
    if (upsert.error) throw new Error(upsert.error.message);

    if (!candidate.id.startsWith("lexical-")) {
      const sync = await this.client
        .from("framework_continuity_candidates")
        .update({ decision: input.decision, updated_at: new Date().toISOString() })
        .eq("owner_id", ownerId)
        .eq("framework_id", frameworkId)
        .eq("fingerprint", fingerprint);
      if (sync.error) throw new Error(sync.error.message);
    }

    return this.getSemesterFrameworkContinuity(ownerId, frameworkId);
  }

  private mapClassFeedback(row: Record<string, any>): LessonClassFeedbackRecord {
    return {
      id: row.id,
      notebookId: row.notebook_id,
      lessonFileId: row.lesson_file_id,
      lessonBlueprintId: row.lesson_blueprint_id ?? null,
      semesterFrameworkId: row.semester_framework_id ?? null,
      kind: row.kind,
      statement: row.statement,
      relatedEntityId: row.related_entity_id ?? null,
      continuityFingerprint: row.continuity_fingerprint ?? null,
      continuityDirection: row.continuity_direction ?? null,
      continuityOutcome: row.continuity_outcome ?? null,
      writebackStatus: row.writeback_status ?? null,
      evidence: row.evidence ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createLessonClassFeedback(
    ownerId: string,
    input: CreateLessonClassFeedbackInput,
  ) {
    const file = await this.getLessonFile(ownerId, input.lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    const writebackStatus = input.writebackStatus
      ?? defaultClassFeedbackWritebackStatus({
        kind: input.kind,
        continuityOutcome: input.continuityOutcome ?? null,
      });
    const insert = await this.client.from("lesson_class_feedback").insert({
      owner_id: ownerId,
      notebook_id: file.notebookId,
      lesson_file_id: file.id,
      lesson_blueprint_id: input.lessonBlueprintId ?? file.lessonBlueprintId ?? null,
      semester_framework_id: input.semesterFrameworkId ?? null,
      kind: input.kind,
      statement: input.statement.trim(),
      related_entity_id: input.relatedEntityId ?? null,
      continuity_fingerprint: input.continuityFingerprint ?? null,
      continuity_direction: input.continuityDirection ?? null,
      continuity_outcome: input.continuityOutcome ?? null,
      writeback_status: writebackStatus,
      evidence: input.evidence ?? {},
    }).select("*").single();
    if (insert.error) throw new Error(insert.error.message);
    return this.mapClassFeedback(insert.data);
  }

  async markLessonClassFeedbackWriteback(
    ownerId: string,
    feedbackId: string,
    status: "pending" | "applied" | "not_applicable",
  ) {
    const update = await this.client.from("lesson_class_feedback").update({
      writeback_status: status,
      updated_at: new Date().toISOString(),
    }).eq("owner_id", ownerId).eq("id", feedbackId).select("*").maybeSingle();
    if (update.error) throw new Error(update.error.message);
    if (!update.data) throw new Error("lesson_class_feedback_not_found");
    return this.mapClassFeedback(update.data);
  }

  async listLessonClassFeedback(
    ownerId: string,
    filter: {
      lessonFileId?: string;
      lessonBlueprintId?: string;
      semesterFrameworkId?: string;
    },
  ) {
    let query = this.client
      .from("lesson_class_feedback")
      .select("*")
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false });
    if (filter.lessonFileId) query = query.eq("lesson_file_id", filter.lessonFileId);
    if (filter.lessonBlueprintId) {
      query = query.eq("lesson_blueprint_id", filter.lessonBlueprintId);
    }
    if (filter.semesterFrameworkId) {
      query = query.eq("semester_framework_id", filter.semesterFrameworkId);
    }
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map((row) => this.mapClassFeedback(row));
  }

  async findClassroomPresentationByRequest(ownerId: string, idempotencyKey: string) {
    const result = await this.client.from("classroom_presentation_documents").select("*")
      .eq("owner_id", ownerId).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapDirectClassroomPresentation(result.data) : null;
  }

  async saveClassroomPresentation(presentation: DirectClassroomPresentationRecord) {
    const replay = await this.findClassroomPresentationByRequest(
      presentation.ownerId,
      presentation.idempotencyKey,
    );
    if (replay) return replay;
    const result = await this.client.from("classroom_presentation_documents").insert({
      id: presentation.id,
      owner_id: presentation.ownerId,
      notebook_id: presentation.notebookId,
      lesson_file_id: presentation.lessonFileId,
      title: presentation.title,
      theme: presentation.theme,
      source_document_version: presentation.sourceDocumentVersion,
      source_document: presentation.sourceDocument,
      // The database column name is retained for old local rows. New records
      // store Dashi's native goal.json there.
      outline: presentation.dashiGoal,
      delivery: presentation.delivery,
      storage_key: presentation.storageKey,
      media_type: presentation.mediaType,
      byte_size: presentation.byteSize,
      checksum: presentation.checksum,
      idempotency_key: presentation.idempotencyKey,
      created_at: presentation.createdAt,
      updated_at: presentation.updatedAt,
    }).select("*").maybeSingle();
    if (result.error?.code === "23505") {
      const existing = await this.findClassroomPresentationByRequest(
        presentation.ownerId,
        presentation.idempotencyKey,
      );
      if (existing) return existing;
    }
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("presentation_save_failed");
    return mapDirectClassroomPresentation(result.data);
  }

  async listClassroomPresentations(ownerId: string, lessonFileId: string) {
    const file = await this.getLessonFile(ownerId, lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    const result = await this.client.from("classroom_presentation_documents").select("*")
      .eq("owner_id", ownerId).eq("notebook_id", file.notebookId)
      .eq("lesson_file_id", lessonFileId).order("updated_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapDirectClassroomPresentation);
  }

  async listClassroomPresentationsForOwner(ownerId: string) {
    const result = await this.client.from("classroom_presentation_documents").select("*")
      .eq("owner_id", ownerId).order("updated_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapDirectClassroomPresentation);
  }

  async listRecentClassroomPresentations(ownerId: string, limit = 8) {
    const result = await this.client.from("classroom_presentation_documents").select("*")
      .eq("owner_id", ownerId).order("updated_at", { ascending: false }).limit(limit);
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapDirectClassroomPresentation);
  }

  async getClassroomPresentation(ownerId: string, presentationId: string) {
    const result = await this.client.from("classroom_presentation_documents").select("*")
      .eq("owner_id", ownerId).eq("id", presentationId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) return null;
    const presentation = mapDirectClassroomPresentation(result.data);
    const file = await this.getLessonFile(ownerId, presentation.lessonFileId);
    return file && file.notebookId === presentation.notebookId ? presentation : null;
  }

  async updateClassroomPresentationArtifact(args: {
    ownerId: string; presentationId: string; storageKey: string; byteSize: number; updatedAt: string;
  }) {
    const result = await this.client.from("classroom_presentation_documents").update({
      storage_key: args.storageKey,
      byte_size: args.byteSize,
      updated_at: args.updatedAt,
    }).eq("owner_id", args.ownerId).eq("id", args.presentationId).select("*").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("presentation_not_found");
    return mapDirectClassroomPresentation(result.data);
  }

  async deleteClassroomPresentation(ownerId: string, presentationId: string) {
    const presentation = await this.getClassroomPresentation(ownerId, presentationId);
    if (!presentation) throw new Error("presentation_not_found");
    const result = await this.client.from("classroom_presentation_documents").delete()
      .eq("owner_id", ownerId).eq("id", presentationId);
    if (result.error) throw new Error(result.error.message);
  }

  async beginClassroomPresentationGeneration(
    generation: ClassroomPresentationGeneration,
  ): Promise<BeginClassroomPresentationGenerationResult> {
    const insert = await this.client.from("classroom_presentation_generations").insert({
      id: generation.id,
      owner_id: generation.ownerId,
      notebook_id: generation.notebookId,
      lesson_file_id: generation.lessonFileId,
      source_document_version: generation.sourceDocumentVersion,
      source_document: generation.sourceDocument,
      lesson_title: generation.lessonTitle,
      subject: generation.subject,
      grade_level: generation.gradeLevel,
      learner_profile: generation.learnerProfile,
      lesson_duration_minutes: generation.lessonDurationMinutes,
      storyboard: generation.goal,
      status: generation.status,
      presentation_id: null,
      error_code: null,
      started_at: generation.startedAt,
    }).select("*").maybeSingle();
    if (!insert.error && insert.data) {
      return { generation: mapClassroomPresentationGeneration(insert.data), created: true };
    }
    // The partial unique index allows exactly one active generation per lesson.
    // A concurrent A4 click or Agent tool call joins that durable operation.
    if (insert.error?.code === "23505") {
      const active = await this.client.from("classroom_presentation_generations").select("*")
        .eq("owner_id", generation.ownerId).eq("lesson_file_id", generation.lessonFileId)
        .eq("status", "generating").maybeSingle();
      if (!active.error && active.data) {
        return { generation: mapClassroomPresentationGeneration(active.data), created: false };
      }
    }
    if (insert.error) throw new Error(insert.error.message);
    throw new Error("presentation_generation_start_failed");
  }

  async getLatestClassroomPresentationGeneration(ownerId: string, lessonFileId: string) {
    const file = await this.getLessonFile(ownerId, lessonFileId);
    if (!file) throw new Error("lesson_file_not_found");
    const active = await this.client.from("classroom_presentation_generations").select("*")
      .eq("owner_id", ownerId).eq("notebook_id", file.notebookId).eq("lesson_file_id", lessonFileId)
      .eq("status", "generating").maybeSingle();
    if (active.error) throw new Error(active.error.message);
    if (active.data) return mapClassroomPresentationGeneration(active.data);
    const result = await this.client.from("classroom_presentation_generations").select("*")
      .eq("owner_id", ownerId).eq("notebook_id", file.notebookId).eq("lesson_file_id", lessonFileId)
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapClassroomPresentationGeneration(result.data) : null;
  }

  async completeClassroomPresentationGeneration(args: {
    ownerId: string; generationId: string; presentationId: string; completedAt: string; durationMs: number;
  }) {
    const result = await this.client.from("classroom_presentation_generations").update({
      status: "ready", presentation_id: args.presentationId, error_code: null,
      completed_at: args.completedAt, duration_ms: args.durationMs,
    }).eq("owner_id", args.ownerId).eq("id", args.generationId).eq("status", "generating")
      .select("*").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("presentation_generation_not_found");
    return mapClassroomPresentationGeneration(result.data);
  }

  async failClassroomPresentationGeneration(args: {
    ownerId: string; generationId: string; errorCode: string; completedAt: string; durationMs: number;
  }) {
    const result = await this.client.from("classroom_presentation_generations").update({
      status: "failed", error_code: args.errorCode, presentation_id: null,
      completed_at: args.completedAt, duration_ms: args.durationMs,
    }).eq("owner_id", args.ownerId).eq("id", args.generationId).eq("status", "generating")
      .select("*").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("presentation_generation_not_found");
    return mapClassroomPresentationGeneration(result.data);
  }

  async recoverInterruptedClassroomPresentationGenerations(completedAt: string) {
    const pending = await this.client.from("classroom_presentation_generations")
      .select("id,owner_id,started_at").eq("status", "generating");
    if (pending.error) throw new Error(pending.error.message);
    const recovered = await Promise.all((pending.data ?? []).map(async (generation) => {
      const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(generation.started_at));
      const result = await this.client.from("classroom_presentation_generations").update({
        status: "failed",
        presentation_id: null,
        error_code: "presentation_generation_interrupted",
        completed_at: completedAt,
        duration_ms: durationMs,
      }).eq("owner_id", generation.owner_id).eq("id", generation.id).eq("status", "generating")
        .select("id").maybeSingle();
      if (result.error) throw new Error(result.error.message);
      return result.data ? 1 : 0;
    }));
    return recovered.reduce<number>((total, count) => total + count, 0);
  }

  async getCurrentCurriculumCatalogRelease() {
    const pointer = await this.client
      .from("curriculum_catalog_current")
      .select("catalog_release_id")
      .eq("singleton", true)
      .maybeSingle();
    if (pointer.error) throw new Error(pointer.error.message);
    return pointer.data?.catalog_release_id
      ? this.getCurriculumCatalogRelease(pointer.data.catalog_release_id)
      : null;
  }

  async getCurriculumCatalogRelease(releaseId: string) {
    const result = await this.client
      .from("curriculum_catalog_releases")
      .select("*")
      .eq("id", releaseId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapCurriculumCatalogRelease(result.data) : null;
  }

  async listCurriculumFacets() {
    const result = await this.client
      .from("curriculum_textbooks")
      .select("stage,subject,edition,grade")
      .is("retired_at", null);
    if (result.error) throw new Error(result.error.message);
    return buildCurriculumFacets((result.data ?? []).map((row) => ({
      id: "",
      title: "",
      stage: row.stage ?? "",
      subject: row.subject ?? "",
      edition: row.edition ?? "",
      grade: row.grade ?? "",
      volume: "",
      publisherId: "",
      ebookId: null,
      detailUrl: null,
      treeUrl: null,
      sourcePdfUrl: null,
      sourceListUrl: null,
      nodeCount: 0,
      sourceUpdatedAt: null,
    })));
  }

  async searchCurriculumTextbooks(filter: CurriculumTextbookFilter = {}) {
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200);
    const result = await this.client.rpc("search_curriculum_textbooks", {
      p_stage: filter.stage?.trim() || null,
      p_subject: filter.subject?.trim() || null,
      p_edition: filter.edition?.trim() || null,
      p_grade: filter.grade?.trim() || null,
      p_query: filter.query?.trim() || null,
      p_limit: limit,
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapCurriculumTextbook);
  }

  async getCurriculumTextbook(textbookId: string, catalogReleaseId?: string) {
    const result = catalogReleaseId
      ? await this.client
        .from("curriculum_textbook_revisions")
        .select("*")
        .eq("catalog_release_id", catalogReleaseId)
        .eq("textbook_id", textbookId)
        .maybeSingle()
      : await this.client
        .from("curriculum_textbooks")
        .select("*")
        .eq("id", textbookId)
        .is("retired_at", null)
        .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? mapCurriculumTextbook(result.data) : null;
  }

  async listCurriculumNodes(args: {
    textbookId: string;
    catalogReleaseId?: string;
    parentId?: string | null;
    maxLevel?: number;
  }) {
    const maxLevel = Math.min(Math.max(args.maxLevel ?? 3, 1), 8);
    let query = args.catalogReleaseId
      ? this.client
        .from("curriculum_node_revisions")
        .select("*")
        .eq("catalog_release_id", args.catalogReleaseId)
        .eq("textbook_id", args.textbookId)
        .lte("level", maxLevel)
        .order("level", { ascending: true })
        .order("sort_no", { ascending: true })
      : this.client
        .from("curriculum_nodes")
        .select("*")
        .eq("textbook_id", args.textbookId)
        .is("retired_at", null)
        .lte("level", maxLevel)
        .order("level", { ascending: true })
        .order("sort_no", { ascending: true });

    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return buildCurriculumOutline((result.data ?? []).map(mapCurriculumNode), {
      parentId: args.parentId,
      maxLevel,
    });
  }

  async searchCurriculumNodes(args: Parameters<LessonRepository["searchCurriculumNodes"]>[0]) {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    let nodeQuery = this.client
      .from("curriculum_nodes")
      .select("*")
      .ilike("title", `%${normalizeCurriculumNodeQuery(args.query)}%`)
      .is("retired_at", null)
      .order("title", { ascending: true })
      .limit(Math.max(limit * 10, 100));
    if (args.textbookId) nodeQuery = nodeQuery.eq("textbook_id", args.textbookId);
    const nodeResult = await nodeQuery;
    if (nodeResult.error) throw new Error(nodeResult.error.message);
    const matchedNodes = (nodeResult.data ?? []).map(mapCurriculumNode);
    const textbookIds = [...new Set(matchedNodes.map((node) => node.textbookId))];
    if (!textbookIds.length) return [];
    const booksResult = await this.client
      .from("curriculum_textbooks")
      .select("*")
      .in("id", textbookIds)
      .is("retired_at", null);
    if (booksResult.error) throw new Error(booksResult.error.message);
    const textbooks = (booksResult.data ?? []).map(mapCurriculumTextbook);
    const topMatches = searchCurriculumNodeRecords({
      textbooks,
      nodes: matchedNodes,
      ...args,
      limit,
    });
    const selectedTextbookIds = [...new Set(
      topMatches.map((match) => match.textbook.id),
    )];
    const nodeResults = await Promise.all(selectedTextbookIds.map((textbookId) => (
      this.client
        .from("curriculum_nodes")
        .select("*")
        .eq("textbook_id", textbookId)
        .is("retired_at", null)
        .order("level", { ascending: true })
        .order("sort_no", { ascending: true })
    )));
    for (const result of nodeResults) {
      if (result.error) throw new Error(result.error.message);
    }
    return searchCurriculumNodeRecords({
      textbooks,
      nodes: nodeResults.flatMap((result) => (
        (result.data ?? []).map(mapCurriculumNode)
      )),
      ...args,
      limit,
    });
  }

  async readCurriculumNodeSemantics(
    args: Parameters<LessonRepository["readCurriculumNodeSemantics"]>[0],
  ): Promise<CurriculumNodeSemanticsRecord> {
    const result = await this.client.rpc("read_curriculum_node_semantics", {
      p_textbook_id: args.textbookId,
      p_node_id: args.nodeId,
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? { release: null, mappings: [] }) as CurriculumNodeSemanticsRecord;
  }

  async getCurriculumSemanticEntity(entityId: string): Promise<CurriculumSemanticEntityRecord | null> {
    const result = await this.client.rpc("get_curriculum_semantic_entity", {
      p_entity_id: entityId,
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data as CurriculumSemanticEntityRecord | null) ?? null;
  }

  async traceCurriculumSemanticPath(
    args: Parameters<LessonRepository["traceCurriculumSemanticPath"]>[0],
  ): Promise<CurriculumSemanticPathStep[]> {
    const result = await this.client.rpc("trace_curriculum_semantic_path", {
      p_entity_id: args.entityId,
      p_direction: args.direction,
      p_relation_types: args.relationTypes ?? ["prerequisite", "develops_into", "supports"],
      p_max_depth: Math.min(Math.max(args.maxDepth ?? 3, 1), 6),
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []) as CurriculumSemanticPathStep[];
  }

  async readCurriculumNodeKnowledgePoints(
    args: Parameters<LessonRepository["readCurriculumNodeKnowledgePoints"]>[0],
  ): Promise<CurriculumNodeKnowledgeRecord> {
    const result = await this.client.rpc("read_curriculum_node_knowledge_points", {
      p_textbook_id: args.textbookId,
      p_node_id: args.nodeId,
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? {
      release: null,
      points: [],
      periodRecommendations: [],
    }) as CurriculumNodeKnowledgeRecord;
  }

  async readCurriculumNodesKnowledgePoints(
    args: Parameters<LessonRepository["readCurriculumNodesKnowledgePoints"]>[0],
  ): Promise<Record<string, CurriculumNodeKnowledgeRecord>> {
    const nodeIds = [...new Set(args.nodeIds)].slice(0, 100);
    const result = await this.client.rpc("read_curriculum_nodes_knowledge_points", {
      p_textbook_id: args.textbookId,
      p_node_ids: nodeIds,
    });
    if (result.error) {
      const batchFunctionUnavailable = result.error.code === "PGRST202"
        || result.error.message.includes("read_curriculum_nodes_knowledge_points");
      if (!batchFunctionUnavailable) throw new Error(result.error.message);

      const records = await Promise.all(nodeIds.map(async (nodeId) => [
        nodeId,
        await this.readCurriculumNodeKnowledgePoints({ textbookId: args.textbookId, nodeId }),
      ] as const));
      return Object.fromEntries(records);
    }
    return (result.data ?? {}) as Record<string, CurriculumNodeKnowledgeRecord>;
  }

  async searchCurriculumKnowledgePoints(
    args: Parameters<LessonRepository["searchCurriculumKnowledgePoints"]>[0],
  ): Promise<CurriculumKnowledgeSearchResult[]> {
    const result = await this.client.rpc("search_curriculum_knowledge_points", {
      p_textbook_id: args.textbookId,
      p_query: args.query,
      p_query_embedding: args.embedding ?? null,
      p_limit: Math.min(Math.max(args.limit ?? 12, 1), 30),
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []) as CurriculumKnowledgeSearchResult[];
  }

  async readCurriculumKnowledgeContinuity(
    args: Parameters<LessonRepository["readCurriculumKnowledgeContinuity"]>[0],
  ): Promise<CurriculumKnowledgeContinuityRecord> {
    const result = await this.client.rpc("read_curriculum_knowledge_continuity", {
      p_textbook_id: args.textbookId,
      p_current_node_id: args.currentNodeId,
      p_entity_id: args.entityId,
      p_limit: Math.min(Math.max(args.limit ?? 12, 1), 30),
    });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? {
      status: "unavailable",
      currentSequenceNo: null,
      candidates: [],
    }) as CurriculumKnowledgeContinuityRecord;
  }
}
