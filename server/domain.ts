import { z } from "zod";
import { dashiJsonValueSchema, type DashiGoal } from "./presentations/dashi-goal.js";
import type { DecisionOption } from "./decisions/contracts.js";
import type { ObservationPlan } from "./learning/observation-plan.js";

export const lessonFieldSchema = z.enum([
  "unit",
  "period",
  "totalPeriods",
  "topic",
  "objectives",
  "knowledgePoints",
  "continuity",
  "focus",
  "preparation",
  "process",
  "assessment",
  "homework",
  "board",
  "reflection",
]);

export const lessonPlanSchema = z.object({
  unit: z.string(),
  period: z.string(),
  totalPeriods: z.string(),
  topic: z.string(),
  objectives: z.string(),
  knowledgePoints: z.string().default(""),
  continuity: z.string().default(""),
  focus: z.string(),
  preparation: z.string(),
  process: z.string(),
  assessment: z.string(),
  homework: z.string(),
  board: z.string(),
  reflection: z.string(),
});

export type LessonPlan = z.infer<typeof lessonPlanSchema>;
export type LessonField = z.infer<typeof lessonFieldSchema>;

export const presentationGoalToolSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(240),
  goal: z.string().trim().min(1).max(2_000),
  audience: z.string().trim().max(500).optional(),
  slides: z.array(z.object({
    layout: z.string().regex(/^theme(?:0[1-9]|1[0-2])_page\d{3}$/),
    props: z.record(z.string(), dashiJsonValueSchema),
  }).strict()).min(1).max(40),
}).strict();

export type PresentationGoalPatch = {
  kind: "presentation_storyboard";
  fileId: string;
  documentVersion: number;
  summary: string;
  goal: DashiGoal;
};

export const lessonContextProfileSchema = z.object({
  gradeLevel: z.string().trim().max(80).optional(),
  textbookEdition: z.string().trim().max(120).optional(),
  textbookId: z.string().trim().min(1).max(80).optional(),
  unitNodeId: z.string().trim().min(1).max(80).optional(),
  lessonNodeId: z.string().trim().min(1).max(80).optional(),
  lessonDurationMinutes: z.number().int().min(10).max(180).optional(),
  learnerProfile: z.string().trim().max(1_000).optional(),
  equipmentConditions: z.string().trim().max(500).optional(),
});

export type LessonContextProfile = z.infer<typeof lessonContextProfileSchema>;

export const sourceRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().optional(),
  kind: z.enum(["public", "private", "web"]),
  page: z.number().int().positive().optional(),
  chunkId: z.string().optional(),
});

export const patchOperationSchema = z.object({
  op: z.literal("replace_text"),
  field: lessonFieldSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  expectedText: z.string(),
  replacement: z.string(),
  contextBefore: z.string().max(80).optional(),
  contextAfter: z.string().max(80).optional(),
}).refine(
  (operation) => operation.expectedText !== operation.replacement,
  { message: "no_effect_patch" },
);

const documentPatchProjectionSchema = z.object({
  basisId: z.string().uuid(),
  // Chronology only. Entry/field snapshots below are the actual conflict boundary.
  baseBasisVersion: z.number().int().nonnegative(),
  entryRefs: z.array(z.object({
    entryId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    expectedStatement: z.string().min(1).max(20_000),
  })).max(64),
  expectedLearnerContext: z.record(z.string(), z.unknown()).optional(),
  operationMappings: z.array(z.object({
    operationIndex: z.number().int().nonnegative(),
    entryIds: z.array(z.string().uuid()).max(16),
    usesLearnerContext: z.boolean(),
  })).min(1).max(32),
});

export const documentPatchSchema = z.object({
  fileId: z.string().min(1),
  baseDocumentVersion: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  operations: z.array(patchOperationSchema).min(1).max(32),
  citations: z.preprocess(
    (citations) => citations === null ? undefined : citations,
    z.array(sourceRefSchema).max(24).optional(),
  ),
  projection: documentPatchProjectionSchema.optional(),
  qualityPrediction: z.object({
    passed: z.boolean(),
    score: z.number().min(0).max(1),
    issues: z.array(z.string()).max(12),
  }).optional(),
});

const documentPatchToolOperationSchema = z.object({
  field: lessonFieldSchema,
  // Omit expectedText to replace the whole semantic A4 field. The server binds
  // the current full-field snapshot so ordinary rewrites do not depend on the
  // model reproducing a unique substring. Keep expectedText only for a genuine
  // local edit inside a field.
  //
  // Identity ops (expectedText === replacement, or a whole-field rewrite that
  // matches the current snapshot) are accepted here. materializeDocumentPatch
  // strips them so a full rewrite that re-echoes stable unit/period/topic does
  // not reject the useful instructional fields in the same proposal.
  expectedText: z.string().nullable().optional(),
  replacement: z.string(),
});

export const documentPatchToolSchema = z.object({
  summary: z.string().min(1).max(500),
  // Versions, offsets, context anchors and citations are server-owned.
  operations: z.array(documentPatchToolOperationSchema).min(1).max(32),
});

// Production Pi contract: document writes target semantic A4 fields. The
// server binds the full current field as expectedText, so the model cannot
// accidentally turn a whole-field rewrite into a brittle substring edit by
// echoing normalized text imperfectly. The older schema remains exported only
// for decoding historical/test proposals.
export const documentFieldPatchToolSchema = z.object({
  summary: z.string().min(1).max(500),
  operations: z.array(z.object({
    field: lessonFieldSchema,
    replacement: z.string(),
  })).min(1).max(32),
});

// A design-basis projection targets a semantic A4 field, not an arbitrary text
// occurrence. The server binds the current full field as the approval snapshot.
// Requiring the model to echo source text here made a stable resource operation
// depend on brittle, occasionally lossy string copying.
const designBasisProjectionToolOperationSchema = z.object({
  field: lessonFieldSchema,
  replacement: z.string(),
  basisEntryIds: z.array(z.string().uuid()).max(16).default([]),
  usesLearnerContext: z.boolean().default(false),
}).superRefine((operation, context) => {
  if (!operation.basisEntryIds.length && !operation.usesLearnerContext) {
    context.addIssue({
      code: "custom",
      path: ["basisEntryIds"],
      message: "projection_source_required",
    });
  }
  if (new Set(operation.basisEntryIds).size !== operation.basisEntryIds.length) {
    context.addIssue({
      code: "custom",
      path: ["basisEntryIds"],
      message: "duplicate_projection_entry",
    });
  }
});

export const designBasisProjectionToolSchema = z.object({
  summary: z.string().min(1).max(500),
  operations: z.array(designBasisProjectionToolOperationSchema).min(1).max(32),
}).superRefine((value, context) => {
  const fields = value.operations.map((operation) => operation.field);
  if (new Set(fields).size !== fields.length) {
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "duplicate_projection_field",
    });
  }
});

export type DocumentPatch = z.infer<typeof documentPatchSchema>;
export type DocumentPatchProposal = z.infer<typeof documentPatchToolSchema>;
export type DocumentFieldPatchProposal = z.infer<typeof documentFieldPatchToolSchema>;
export type DesignBasisProjectionProposal = z.infer<typeof designBasisProjectionToolSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;

const semesterFrameworkFieldSchema = z.enum([
  "title",
  "term",
  "startDate",
  "totalWeeks",
  "weeklyPeriods",
  "lessonDurationMinutes",
  "capacityRatio",
  "planningHorizonWeeks",
  "contextProfile",
  "status",
]);

const semesterUnitFieldSchema = z.enum([
  "plannedStartWeek",
  "plannedEndWeek",
  "plannedPeriods",
  "learningGoals",
  "teacherNotes",
  "status",
]);

const lessonBlueprintStatusSchema = z.enum([
  "draft",
  "ready",
  "taught",
  "adjusted",
  "cancelled",
]);

const lessonBlueprintContentSchema = z.object({
  semesterUnitId: z.string().uuid(),
  curriculumNodeId: z.string().trim().min(1).max(120),
  chapterPeriodNo: z.number().int().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  mainActivity: z.string().max(20_000),
  observableProduct: z.string().max(20_000),
  assessmentEvidence: z.string().max(20_000),
  anticipatedDifficulties: z.array(z.unknown()).max(100),
  plannedMinutes: z.number().int().min(20).max(60),
  teacherNotes: z.string().max(20_000),
});

const lessonBlueprintFieldSchema = z.enum([
  "curriculumNodeId",
  "title",
  "mainActivity",
  "observableProduct",
  "assessmentEvidence",
  "anticipatedDifficulties",
  "plannedMinutes",
  "teacherNotes",
  "status",
]);

const resourcePatchValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const replaceFrameworkFieldOperationSchema = z.object({
  op: z.literal("replace_framework_field"),
  field: semesterFrameworkFieldSchema,
  expectedValue: resourcePatchValueSchema,
  replacement: resourcePatchValueSchema,
});

const replaceUnitFieldOperationSchema = z.object({
  op: z.literal("replace_unit_field"),
  unitId: z.string().uuid(),
  field: semesterUnitFieldSchema,
  expectedValue: resourcePatchValueSchema,
  replacement: resourcePatchValueSchema,
});

const createLessonBlueprintProposalOperationSchema = lessonBlueprintContentSchema.extend({
  op: z.literal("create_lesson_blueprint"),
  mainActivity: z.string().trim().min(1).max(20_000),
  observableProduct: z.string().trim().min(1).max(20_000),
  assessmentEvidence: z.string().trim().min(1).max(20_000),
  anticipatedDifficulties: z.array(z.unknown()).max(100).default([]),
  chapterPeriodNo: z.number().int().min(1).max(100).nullable(),
  plannedMinutes: z.number().int().min(20).max(60).nullable(),
  teacherNotes: z.string().max(20_000).default(""),
});

const plannedLessonBlueprintSchema = createLessonBlueprintProposalOperationSchema.omit({
  op: true,
  semesterUnitId: true,
});

// A semester plan is a business command, not dozens of hand-written field
// mutations. The server expands this compact unit plan into snapshot-bound
// operations before the teacher sees one atomic approval.
const planSemesterUnitProposalOperationSchema = z.object({
  op: z.literal("plan_semester_unit"),
  unitId: z.string().uuid(),
  plannedStartWeek: z.number().int().min(1).max(30).nullable(),
  plannedEndWeek: z.number().int().min(1).max(30).nullable(),
  learningGoals: z.string().trim().min(1).max(20_000),
  blueprints: z.array(plannedLessonBlueprintSchema).min(1).max(100),
});

const replaceLessonBlueprintFieldOperationSchema = z.object({
  op: z.literal("replace_lesson_blueprint_field"),
  blueprintId: z.string().uuid(),
  field: lessonBlueprintFieldSchema,
  expectedValue: resourcePatchValueSchema,
  replacement: resourcePatchValueSchema,
});

const deleteLessonBlueprintProposalOperationSchema = z.object({
  op: z.literal("delete_lesson_blueprint"),
  blueprintId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
});

const deleteLessonBlueprintOperationSchema = deleteLessonBlueprintProposalOperationSchema.extend({
  expectedTitle: z.string().trim().min(1).max(200).optional(),
  expectedSemesterUnitId: z.string().uuid().optional(),
});

const noEffectPatch = (operation: unknown) => {
  if (!operation || typeof operation !== "object" || !("expectedValue" in operation)) return true;
  const replace = operation as { expectedValue: unknown; replacement?: unknown };
  return JSON.stringify(replace.expectedValue) !== JSON.stringify(replace.replacement);
};

const semesterFrameworkPatchProposalOperationSchema = z.discriminatedUnion("op", [
  replaceFrameworkFieldOperationSchema,
  replaceUnitFieldOperationSchema,
  createLessonBlueprintProposalOperationSchema,
  planSemesterUnitProposalOperationSchema,
  replaceLessonBlueprintFieldOperationSchema,
  deleteLessonBlueprintProposalOperationSchema,
]).refine(noEffectPatch, { message: "no_effect_patch" });

const createLessonBlueprintOperationSchema = createLessonBlueprintProposalOperationSchema.extend({
  blueprintId: z.string().uuid(),
  chapterPeriodNo: z.number().int().min(1).max(100),
  plannedPeriod: z.number().int().positive(),
  sortNo: z.number().int().positive(),
  plannedMinutes: z.number().int().min(20).max(60),
  status: lessonBlueprintStatusSchema.default("draft"),
});

const semesterFrameworkPatchOperationSchema = z.discriminatedUnion("op", [
  replaceFrameworkFieldOperationSchema,
  replaceUnitFieldOperationSchema,
  createLessonBlueprintOperationSchema,
  replaceLessonBlueprintFieldOperationSchema,
  deleteLessonBlueprintOperationSchema,
]).refine(noEffectPatch, { message: "no_effect_patch" });

export const semesterFrameworkPatchToolSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  operations: z.array(semesterFrameworkPatchProposalOperationSchema).min(1).max(64),
});

export const semesterFrameworkPatchSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  operations: z.array(semesterFrameworkPatchOperationSchema).min(1).max(128),
  frameworkId: z.string().uuid(),
  baseFrameworkVersion: z.number().int().nonnegative(),
});

export type SemesterFrameworkPatchProposal = z.infer<typeof semesterFrameworkPatchToolSchema>;
export type SemesterFrameworkPatch = z.infer<typeof semesterFrameworkPatchSchema>;

export const lessonDesignBasisStatusSchema = z.enum(["draft", "confirmed", "stale"]);
export const lessonDesignBasisEntryKindSchema = z.enum([
  "knowledge_point",
  "review",
  "prepare",
  "student_difficulty",
  "assessment_evidence",
  "teaching_decision",
]);
export const lessonDesignBasisEntryDecisionSchema = z.enum([
  "accepted",
  "dismissed",
]);

const lessonDesignBasisEntryReferenceShape = {
  kind: lessonDesignBasisEntryKindSchema,
  semanticEntityId: z.string().uuid().nullable().default(null),
  relatedSemanticEntityId: z.string().uuid().nullable().default(null),
  relatedCurriculumNodeId: z.string().trim().min(1).max(120).nullable().default(null),
  statement: z.string().trim().min(1).max(20_000),
  rationale: z.string().max(20_000).default(""),
  decision: lessonDesignBasisEntryDecisionSchema.default("accepted"),
} as const;

const lessonDesignBasisEntryContentShape = {
  ...lessonDesignBasisEntryReferenceShape,
  evidence: z.array(sourceRefSchema).max(24).default([]),
  origin: z.enum(["platform", "teacher", "agent", "import"]).default("agent"),
} as const;

const validateLessonDesignBasisEntry = (
  value: z.infer<z.ZodObject<typeof lessonDesignBasisEntryReferenceShape>>,
  context: z.RefinementCtx,
) => {
  if (value.kind === "knowledge_point" && !value.semanticEntityId) {
    context.addIssue({ code: "custom", path: ["semanticEntityId"], message: "semantic_entity_required" });
  }
  if (
    (value.kind === "review" || value.kind === "prepare")
    && (!value.semanticEntityId || !value.relatedSemanticEntityId || !value.relatedCurriculumNodeId)
  ) {
    context.addIssue({ code: "custom", path: ["relatedSemanticEntityId"], message: "continuity_reference_required" });
  }
  if (
    (value.kind === "knowledge_point"
      || value.kind === "student_difficulty"
      || value.kind === "assessment_evidence"
      || value.kind === "teaching_decision")
    && (value.relatedSemanticEntityId || value.relatedCurriculumNodeId)
  ) {
    context.addIssue({ code: "custom", path: ["relatedSemanticEntityId"], message: "unexpected_continuity_reference" });
  }
};

const lessonDesignBasisObjectValueSchema = z.record(z.string(), z.unknown());

const createLessonDesignBasisEntryProposalSchema = z.object({
  ...lessonDesignBasisEntryReferenceShape,
  op: z.literal("create_design_basis_entry"),
  evidenceSourceIds: z.array(z.string().min(1)).max(24).default([]),
}).superRefine(validateLessonDesignBasisEntry);

const replaceLessonDesignBasisFieldOperationSchema = z.union([
  z.object({
    op: z.literal("replace_design_basis_field"),
    field: z.literal("learnerContext"),
    expectedValue: lessonDesignBasisObjectValueSchema,
    replacement: lessonDesignBasisObjectValueSchema,
  }),
  z.object({
    op: z.literal("replace_design_basis_field"),
    field: z.literal("teacherNotes"),
    expectedValue: z.string().max(20_000),
    replacement: z.string().max(20_000),
  }),
  z.object({
    op: z.literal("replace_design_basis_field"),
    field: z.literal("status"),
    expectedValue: lessonDesignBasisStatusSchema,
    replacement: lessonDesignBasisStatusSchema,
  }),
]).refine(noEffectPatch, { message: "no_effect_patch" });

const replaceLessonDesignBasisEntryFieldOperationSchema = z.union([
  z.object({
    op: z.literal("replace_design_basis_entry_field"),
    entryId: z.string().uuid(),
    field: z.literal("statement"),
    expectedValue: z.string().min(1).max(20_000),
    replacement: z.string().min(1).max(20_000),
  }),
  z.object({
    op: z.literal("replace_design_basis_entry_field"),
    entryId: z.string().uuid(),
    field: z.literal("rationale"),
    expectedValue: z.string().max(20_000),
    replacement: z.string().max(20_000),
  }),
  z.object({
    op: z.literal("replace_design_basis_entry_field"),
    entryId: z.string().uuid(),
    field: z.literal("decision"),
    expectedValue: lessonDesignBasisEntryDecisionSchema,
    replacement: lessonDesignBasisEntryDecisionSchema,
  }),
]).refine(noEffectPatch, { message: "no_effect_patch" });

const deleteLessonDesignBasisEntryProposalSchema = z.object({
  op: z.literal("delete_design_basis_entry"),
  entryId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
});

export const lessonDesignBasisPatchToolSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  operations: z.array(z.union([
    replaceLessonDesignBasisFieldOperationSchema,
    createLessonDesignBasisEntryProposalSchema,
    replaceLessonDesignBasisEntryFieldOperationSchema,
    deleteLessonDesignBasisEntryProposalSchema,
  ])).min(1).max(64),
});

const createLessonDesignBasisEntryOperationSchema = z.object({
  ...lessonDesignBasisEntryContentShape,
  op: z.literal("create_design_basis_entry"),
  entryId: z.string().uuid(),
  sortNo: z.number().int().positive(),
  teacherConfirmed: z.boolean().default(true),
}).superRefine(validateLessonDesignBasisEntry);

const deleteLessonDesignBasisEntryOperationSchema = deleteLessonDesignBasisEntryProposalSchema.extend({
  expectedStatement: z.string().trim().min(1).max(20_000).optional(),
});

export const lessonDesignBasisPatchSchema = z.object({
  basisId: z.string().uuid(),
  fileId: z.string().min(1),
  baseBasisVersion: z.number().int().nonnegative(),
  summary: z.string().trim().min(1).max(500),
  operations: z.array(z.union([
    replaceLessonDesignBasisFieldOperationSchema,
    createLessonDesignBasisEntryOperationSchema,
    replaceLessonDesignBasisEntryFieldOperationSchema,
    deleteLessonDesignBasisEntryOperationSchema,
  ])).min(1).max(64),
});

export type LessonDesignBasisPatchProposal = z.infer<typeof lessonDesignBasisPatchToolSchema>;
export type LessonDesignBasisPatch = z.infer<typeof lessonDesignBasisPatchSchema>;

const lessonDesignChangeDocumentOperationSchema = z.object({
  field: lessonFieldSchema,
  replacement: z.string(),
  basisEntryIds: z.array(z.string().uuid()).max(16).default([]),
  createdBasisEntryRefs: z.array(z.string().trim().min(1).max(80)).max(16).default([]),
  usesLearnerContext: z.boolean().default(false),
}).superRefine((operation, context) => {
  if (
    !operation.basisEntryIds.length
    && !operation.createdBasisEntryRefs.length
    && !operation.usesLearnerContext
  ) {
    context.addIssue({
      code: "custom",
      path: ["basisEntryIds"],
      message: "lesson_design_change_source_required",
    });
  }
});

const createLessonDesignBasisEntryChangeProposalSchema = z.object({
  ...lessonDesignBasisEntryReferenceShape,
  op: z.literal("create_design_basis_entry"),
  referenceKey: z.string().trim().min(1).max(80),
  evidenceSourceIds: z.array(z.string().min(1)).max(24).default([]),
}).superRefine(validateLessonDesignBasisEntry);

const lessonDesignChangeBasisOperationSchema = z.union([
  replaceLessonDesignBasisFieldOperationSchema,
  createLessonDesignBasisEntryChangeProposalSchema,
  replaceLessonDesignBasisEntryFieldOperationSchema,
  deleteLessonDesignBasisEntryProposalSchema,
]);

export const lessonDesignChangeToolSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  designBasisOperations: z.array(lessonDesignChangeBasisOperationSchema).min(1).max(64),
  documentOperations: z.array(lessonDesignChangeDocumentOperationSchema).min(1).max(32),
}).superRefine((value, context) => {
  const referenceKeys = value.designBasisOperations.flatMap((operation) => (
    operation.op === "create_design_basis_entry" && operation.referenceKey
      ? [operation.referenceKey]
      : []
  ));
  const createCount = value.designBasisOperations.filter((operation) => (
    operation.op === "create_design_basis_entry"
  )).length;
  if (referenceKeys.length !== createCount || new Set(referenceKeys).size !== referenceKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["designBasisOperations"],
      message: "unique_reference_key_required_for_created_basis_entry",
    });
  }
  const known = new Set(referenceKeys);
  for (const [index, operation] of value.documentOperations.entries()) {
    if (new Set(operation.createdBasisEntryRefs).size !== operation.createdBasisEntryRefs.length) {
      context.addIssue({
        code: "custom",
        path: ["documentOperations", index, "createdBasisEntryRefs"],
        message: "duplicate_created_basis_entry_reference",
      });
    }
    for (const reference of operation.createdBasisEntryRefs) {
      if (!known.has(reference)) {
        context.addIssue({
          code: "custom",
          path: ["documentOperations", index, "createdBasisEntryRefs"],
          message: "unknown_created_basis_entry_reference",
        });
      }
    }
  }
  const documentFields = value.documentOperations.map((operation) => operation.field);
  if (new Set(documentFields).size !== documentFields.length) {
    context.addIssue({
      code: "custom",
      path: ["documentOperations"],
      message: "duplicate_lesson_design_change_field",
    });
  }
});

export const lessonDesignChangePatchSchema = documentPatchSchema.extend({
  designBasisPatch: lessonDesignBasisPatchSchema,
});

export type LessonDesignChangeProposal = z.infer<typeof lessonDesignChangeToolSchema>;
export type LessonDesignChangePatch = z.infer<typeof lessonDesignChangePatchSchema>;
export type ResourcePatch = DocumentPatch | SemesterFrameworkPatch | LessonDesignBasisPatch | LessonDesignChangePatch | PresentationGoalPatch;

export const isPresentationGoalPatch = (
  patch: ResourcePatch,
): patch is PresentationGoalPatch => (
  "kind" in patch && patch.kind === "presentation_storyboard" && "goal" in patch
);

export const isSemesterFrameworkPatch = (
  patch: ResourcePatch,
): patch is SemesterFrameworkPatch => "frameworkId" in patch;

export const isLessonDesignBasisPatch = (
  patch: ResourcePatch,
): patch is LessonDesignBasisPatch => "basisId" in patch;

export const isLessonDesignChangePatch = (
  patch: ResourcePatch,
): patch is LessonDesignChangePatch => "designBasisPatch" in patch;

export type LessonAgentSelection = {
  field: LessonField;
  start: number;
  end: number;
  text: string;
  documentVersion?: number;
};

export type ConfirmedDecisionContext = {
  id: string; version: number; question: string; chosenOption: DecisionOption;
  assumptions: string[]; observationPlan?: ObservationPlan | null;
};

type PreparationAgentContextBase = {
  userId: string;
  notebookId: string;
  threadId: string;
  branchId: string;
  runId: string;
  allowedKnowledgeScopes: string[];
  attachmentSourceIds: string[];
  abortSignal: AbortSignal;
};

export type LessonAgentContext = PreparationAgentContextBase & {
  resourceType?: "lesson_file";
  lessonFileId: string;
  activeSectionId: string;
  selection?: LessonAgentSelection;
  confirmedDecision?: ConfirmedDecisionContext;
  documentVersion: number;
  designBasisVersion: number;
  contextProfile: LessonContextProfile;
};

export type SemesterFrameworkAgentContext = PreparationAgentContextBase & {
  resourceType: "semester_framework";
  semesterFrameworkId: string;
  frameworkVersion: number;
  activeUnitId?: string;
  contextProfile: Record<string, unknown>;
};

export type PreparationAgentContext = LessonAgentContext | SemesterFrameworkAgentContext;

export const isSemesterFrameworkAgentContext = (
  context: PreparationAgentContext,
): context is SemesterFrameworkAgentContext => context.resourceType === "semester_framework";

export type NotebookRecord = {
  id: string;
  ownerId: string;
  title: string;
  className: string;
  year: string;
  subject: string;
  stage: string;
  grade: string;
  edition: string;
  tone: "teal" | "sage" | "amber" | "coral";
  updatedAt: string;
};

export type LessonFileRecord = {
  id: string;
  ownerId: string;
  notebookId: string;
  lessonBlueprintId?: string;
  title: string;
  type: string;
  image?: string;
  document: LessonPlan;
  contextProfile: LessonContextProfile;
  documentVersion: number;
  pageCount: number;
  updatedAt: string;
};

export type LessonFileSummary = Omit<LessonFileRecord, "document" | "contextProfile"> & {
  preview: string[];
};

/**
 * A teacher-initiated generation request. It remains durable until the Pi
 * coordinator claims it for exactly one run, so a page refresh cannot erase it.
 */
export type LessonGenerationIntentRecord = {
  id: string;
  ownerId: string;
  lessonFileId: string;
  prompt: string;
  state: "pending" | "claimed";
  runId?: string;
  createdAt: string;
  claimedAt?: string;
};

/** A durable, approval-gated framework writeback requested by classroom feedback. */
export type SemesterFrameworkWritebackIntentRecord = {
  id: string;
  ownerId: string;
  frameworkId: string;
  feedbackId: string;
  prompt: string;
  state: "pending" | "claimed";
  runId?: string;
  createdAt: string;
  claimedAt?: string;
};

export type NotebookGraphRecord = NotebookRecord & {
  files: LessonFileSummary[];
};

type AgentThreadCommon = {
  id: string;
  ownerId: string;
  notebookId: string;
  title: string;
  // A thread describes whether the conversation currently accepts a new turn.
  // Terminal outcomes belong to the immutable run and assistant-message records.
  status: "idle" | "running" | "awaiting_approval";
  starterSuggestions?: string[];
  starterSuggestionsDocumentVersion?: number;
  starterSuggestionsResourceVersion?: number;
  archivedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentResourceRef =
  | { resourceType: "lesson_file"; lessonFileId: string; semesterFrameworkId?: never }
  | { resourceType: "semester_framework"; lessonFileId?: never; semesterFrameworkId: string };

export type AgentThreadRecord = AgentThreadCommon & AgentResourceRef;

export type AgentBranchRecord = {
  id: string;
  ownerId: string;
  threadId: string;
  parentBranchId?: string;
  forkedFromMessageId?: string;
  label: string;
  pendingInteraction?: AgentPendingInteraction | null;
  createdAt: string;
};

export type AgentPendingInteraction = {
  kind: "presentation_theme" | "presentation_generation";
  originalRequest: string;
  documentVersion: number;
  requestedAt: string;
  confirmedTheme?: string;
  /** The pending task is scoped to its canonical lesson, not the visible tab. */
  resourceId?: string;
  /** A later ordinary turn makes a bare “continue” ambiguous. */
  resumeReferenceRequired?: boolean;
};

export type AgentMessageRecord = {
  id: string;
  ownerId: string;
  threadId: string;
  branchId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "completed" | "streaming" | "cancelled" | "failed";
  error?: string;
  sources?: SourceRef[];
  activities?: AgentActivityRecord[];
  turnTexts?: Record<number, string>;
  turn?: AgentTurnPresentation;
  sessionCursor?: number;
  createdAt: string;
};

export type AgentTurnPresentation = {
  runId: string;
  status: AgentRunRecord["status"];
  phase?: "starting" | "preparing" | "responding" | "using_tools";
  currentTurn?: number;
  startedAt: string;
  completedAt?: string;
};

export type AgentActivityRecord = {
  id: string;
  name: string;
  label: string;
  detail?: string;
  groupKey?: string;
  state: "running" | "completed" | "unchanged" | "needs_revision" | "cancelled" | "failed";
  outcome?: "completed" | "no_change" | "needs_revision" | "cancelled" | "failed";
  revisionCode?: string;
  turn?: number;
  progress?: {
    label: string;
    current?: number;
    total?: number;
  };
};

export type AgentRunRecord = {
  id: string;
  ownerId: string;
  threadId: string;
  branchId: string;
  model: string;
  status: "queued" | "running" | "awaiting_approval" | "completed" | "cancelled" | "failed";
  capabilityPlan?: CapabilityPlan;
  agentDefinitionVersion?: string;
  skillVersions?: Record<string, string>;
  attachmentSourceIds?: string[];
  tokenUsage?: Record<string, number>;
  providerCost?: number;
  error?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  cancelRequestedAt?: string;
  /** Unique durable command that initiated this run, when applicable. */
  generationIntentId?: string;
  /** Browser-owned identity used to make ordinary send retries idempotent. */
  clientCommandId?: string;
  /** Canonical request fingerprint guarding command-id reuse. */
  commandFingerprint?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  startedAt: string;
  completedAt?: string;
};

export type AgentApprovalRecord = {
  id: string;
  ownerId: string;
  runId: string;
  threadId: string;
  branchId: string;
  assistantMessageId?: string;
  /** The proposing tool call, so the browser can attribute this card to it. */
  toolCallId?: string;
  state: "pending" | "approved" | "rejected" | "expired";
  patch: ResourcePatch;
  encryptedRunState: string;
  agentDefinitionVersion: string;
  resourceType?: "lesson_file" | "semester_framework";
  patchKind?: "document" | "semester_framework" | "lesson_blueprint" | "lesson_design_basis" | "presentation_storyboard";
  lessonFileId?: string;
  semesterFrameworkId?: string;
  baseResourceVersion?: number;
  documentVersion?: number;
  continuationStatus?: "pending" | "ready" | "running" | "completed";
  continuationLeaseToken?: string;
  continuationLeaseExpiresAt?: string;
  continuationAttemptCount?: number;
  continuationError?: string;
  continuationMessageId?: string;
  expiresAt: string;
  createdAt: string;
};

export const agentTaskIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("analysis") }).strict(),
  z.object({ type: z.literal("document_write"), fields: z.array(lessonFieldSchema).min(1).max(14).optional(),
    decisionRef: z.object({ id: z.string().uuid(), version: z.number().int().positive(), chosenOptionId: z.string().trim().min(1).max(64) }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal("learning_inquiry"), evidenceId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("learning_review"), inquiryId: z.string().uuid(), evidenceId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("decision_proposal") }).strict(),
]);
export type AgentTaskIntent = z.infer<typeof agentTaskIntentSchema>;

export type CapabilityPlan = {
  taskIntent?: AgentTaskIntent;
  skillIds: string[];
  toolGroups: string[];
  mcpServers: string[];
  evidenceRequired: boolean;
  writeMode?: "consultative" | "open" | "explicit";
  designBasisRequested?: boolean;
  designBasisWriteRequested?: boolean;
  minimalWriteRequested?: boolean;
  fullRewriteRequested?: boolean;
  classroomActionRequired?: boolean;
  continuityRequested?: boolean;
  continuityWritebackFeedbackId?: string;
  lightweightConversation?: boolean;
  /**
   * Fast chat is the same configured model with a compact conversation view
   * and no tools. Agent keeps the stable Skill/tool prefix. Acknowledgements
   * like 谢谢/好的 are Fast model replies, not canned text.
   */
  executionLane?: "fast" | "agent";
  curriculumRequested?: boolean;
  presentationRequested?: boolean;
  presentationThemeConfirmationRequired?: boolean;
  presentationThemeDismissed?: boolean;
  confirmedPresentationTheme?: string;
  /** Rebind still-current evidence from the immediately preceding completed turn. */
  reuseRecentEvidence?: boolean;
  /**
   * A4 fields the teacher explicitly asked to change in this turn. This limits
   * writes only: the Agent may read any additional current-version context it
   * needs to produce a correct result.
   */
  requestedDocumentFields?: LessonField[];
  requiredEvidenceKinds?: AgentRunEvidenceKind[];
};

export type AgentRunEvidenceKind =
  | "knowledge_search"
  | "curriculum_standard_search"
  | "knowledge_passage"
  | "attachment_read"
  | "source_metadata"
  | "web_search"
  | "web_open"
  | "curriculum_textbook"
  | "curriculum_outline"
  | "curriculum_semantics"
  | "curriculum_knowledge";

export type AgentRunEvidenceRecord = {
  ownerId: string;
  runId: string;
  kind: AgentRunEvidenceKind;
  source: SourceRef;
  createdAt: string;
};

export type KnowledgeResult = SourceRef & {
  passage: string;
  score: number;
  section?: string;
};

export type CurriculumStandardSearchCacheRecord = {
  contextFingerprint: string;
  querySha256: string;
  limit: number;
  results: KnowledgeResult[];
  updatedAt: string;
};

export type CurriculumTextbookRecord = {
  id: string;
  title: string;
  stage: string;
  subject: string;
  edition: string;
  grade: string;
  volume: string;
  publisherId: string;
  ebookId: string | null;
  detailUrl: string | null;
  treeUrl: string | null;
  sourcePdfUrl: string | null;
  sourceListUrl: string | null;
  nodeCount: number;
  sourceUpdatedAt: string | null;
};

export type CurriculumCatalogReleaseRecord = {
  id: string;
  generationId: string;
  status: "draft" | "published" | "retired";
  snapshotComplete: boolean;
  manifest: Record<string, unknown>;
  textbookCount: number;
  nodeCount: number;
  createdAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
};

export type CurriculumNodeRecord = {
  textbookId: string;
  nodeId: string;
  parentId: string | null;
  level: number;
  sortNo: number;
  title: string;
  pageNumber: number | null;
};

export const createSemesterFrameworkSchema = z.object({
  textbookId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  term: z.string().trim().min(1).max(40),
  startDate: z.string().date().nullable().optional(),
  totalWeeks: z.number().int().min(1).max(30),
  weeklyPeriods: z.number().int().min(1).max(30),
  lessonDurationMinutes: z.union([z.literal(40), z.literal(45)]).default(40),
  capacityRatio: z.number().min(0.5).max(1).default(0.9),
  planningHorizonWeeks: z.number().int().min(1).max(8).default(2),
  contextProfile: z.record(z.string(), z.unknown()).default({}),
}).superRefine((value, context) => {
  if (value.planningHorizonWeeks > value.totalWeeks) {
    context.addIssue({
      code: "custom",
      path: ["planningHorizonWeeks"],
      message: "planning_horizon_exceeds_term",
    });
  }
});

export type CreateSemesterFrameworkInput = z.infer<typeof createSemesterFrameworkSchema>;

export const createLessonBlueprintSchema = lessonBlueprintContentSchema.extend({
  mainActivity: z.string().max(20_000).default(""),
  observableProduct: z.string().max(20_000).default(""),
  assessmentEvidence: z.string().max(20_000).default(""),
  anticipatedDifficulties: z.array(z.unknown()).max(100).default([]),
  chapterPeriodNo: z.number().int().min(1).max(100).optional(),
  plannedMinutes: z.number().int().min(20).max(60).optional(),
  teacherNotes: z.string().max(20_000).default(""),
});

export type CreateLessonBlueprintInput = z.infer<typeof createLessonBlueprintSchema>;

export const updateLessonBlueprintSchema = createLessonBlueprintSchema
  .omit({ semesterUnitId: true, curriculumNodeId: true, chapterPeriodNo: true })
  .partial()
  .extend({
    expectedVersion: z.number().int().nonnegative(),
    status: lessonBlueprintStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
    message: "empty_blueprint_patch",
  });

export type UpdateLessonBlueprintInput = z.infer<typeof updateLessonBlueprintSchema>;

export const deleteLessonBlueprintSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});

export type DeleteLessonBlueprintInput = z.infer<typeof deleteLessonBlueprintSchema>;

export type SemesterFrameworkRecord = {
  id: string;
  ownerId: string;
  notebookId: string;
  textbookId: string;
  catalogReleaseId: string;
  semanticReleaseId: string | null;
  title: string;
  term: string;
  startDate: string | null;
  totalWeeks: number;
  weeklyPeriods: number;
  lessonDurationMinutes: number;
  capacityRatio: number;
  planningHorizonWeeks: number;
  contextProfile: Record<string, unknown>;
  version: number;
  status: "draft" | "active" | "completed" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type SemesterUnitRecord = {
  id: string;
  frameworkId: string;
  curriculumNodeId: string;
  sortNo: number;
  plannedStartWeek: number | null;
  plannedEndWeek: number | null;
  plannedPeriods: number;
  learningGoals: string;
  teacherNotes: string;
  status: "unplanned" | "planned" | "in_progress" | "completed" | "deferred";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LessonBlueprintRecord = {
  id: string;
  frameworkId: string;
  semesterUnitId: string;
  curriculumNodeId: string;
  chapterPeriodNo: number;
  plannedPeriod: number;
  sortNo: number;
  title: string;
  mainActivity: string;
  observableProduct: string;
  assessmentEvidence: string;
  anticipatedDifficulties: unknown[];
  plannedMinutes: number;
  teacherNotes: string;
  status: "draft" | "ready" | "taught" | "adjusted" | "cancelled";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type FrameworkOutcomeSelectionRecord = {
  id: string;
  frameworkId: string;
  semesterUnitId: string | null;
  lessonBlueprintId: string | null;
  semanticReleaseId: string;
  semanticEntityId: string;
  priority: number;
  teacherConfirmed: boolean;
  teacherAdjusted: boolean;
  adjustmentReason: string;
  createdAt: string;
  updatedAt: string;
};

export type LessonDesignBasisRecord = {
  id: string;
  ownerId: string;
  notebookId: string;
  lessonFileId: string;
  frameworkId: string | null;
  semesterUnitId: string | null;
  lessonBlueprintId: string | null;
  catalogReleaseId: string | null;
  textbookId: string | null;
  curriculumNodeId: string | null;
  semanticReleaseId: string | null;
  sourceFrameworkVersion: number | null;
  sourceBlueprintVersion: number | null;
  learnerContext: Record<string, unknown>;
  teacherNotes: string;
  status: z.infer<typeof lessonDesignBasisStatusSchema>;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LessonDesignBasisEntryRecord = {
  id: string;
  basisId: string;
  kind: z.infer<typeof lessonDesignBasisEntryKindSchema>;
  semanticEntityId: string | null;
  semanticEntityName: string | null;
  relatedSemanticEntityId: string | null;
  relatedSemanticEntityName: string | null;
  relatedCurriculumNodeId: string | null;
  relatedCurriculumNodeTitle: string | null;
  statement: string;
  rationale: string;
  evidence: SourceRef[];
  decision: z.infer<typeof lessonDesignBasisEntryDecisionSchema>;
  teacherConfirmed: boolean;
  origin: "platform" | "teacher" | "agent" | "import";
  sortNo: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LessonDesignBasisAggregate = {
  basis: LessonDesignBasisRecord;
  entries: LessonDesignBasisEntryRecord[];
};

export type SemesterFrameworkAggregate = {
  framework: SemesterFrameworkRecord;
  units: SemesterUnitRecord[];
  blueprints: LessonBlueprintRecord[];
  outcomeSelections: FrameworkOutcomeSelectionRecord[];
};

export type FrameworkContinuityCandidateRecord = {
  id: string;
  frameworkId: string;
  derivedFromFrameworkVersion: number;
  targetUnitId: string;
  direction: "review" | "prepare";
  currentEntityId: string;
  currentPointName: string;
  relatedEntityId: string;
  relatedPointName: string;
  relatedUnitId: string;
  evidenceKind: "same_knowledge_point" | "approved_relation" | "lexical_similarity";
  relationId: string | null;
  relationType: CurriculumSemanticRelation | null;
  confidence: number;
  rationale: string;
  evidence: Record<string, unknown>;
  fingerprint: string;
  decision: "candidate" | "accepted" | "dismissed";
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SetFrameworkContinuityDecisionInput = {
  fingerprint?: string;
  candidateId?: string;
  decision: "accepted" | "dismissed" | "candidate";
  note?: string;
};

export type LessonClassFeedbackKind =
  | "observation"
  | "practice_gap"
  | "error_cause"
  | "continuity_outcome";

export type LessonClassFeedbackRecord = {
  id: string;
  notebookId: string;
  lessonFileId: string;
  lessonBlueprintId: string | null;
  semesterFrameworkId: string | null;
  kind: LessonClassFeedbackKind;
  statement: string;
  relatedEntityId: string | null;
  continuityFingerprint: string | null;
  continuityDirection: "review" | "prepare" | null;
  continuityOutcome: "worked" | "weak" | "skipped" | null;
  writebackStatus: "pending" | "applied" | "not_applicable" | null;
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateLessonClassFeedbackInput = {
  lessonFileId: string;
  kind: LessonClassFeedbackKind;
  statement: string;
  lessonBlueprintId?: string | null;
  semesterFrameworkId?: string | null;
  relatedEntityId?: string | null;
  continuityFingerprint?: string | null;
  continuityDirection?: "review" | "prepare" | null;
  continuityOutcome?: "worked" | "weak" | "skipped" | null;
  writebackStatus?: "pending" | "applied" | "not_applicable" | null;
  evidence?: Record<string, unknown>;
};

export type FrameworkContinuityResult = {
  status: "available" | "semantic_release_unavailable";
  frameworkVersion: number;
  candidates: FrameworkContinuityCandidateRecord[];
};

export type CurriculumNodeMatch = {
  textbook: CurriculumTextbookRecord;
  node: CurriculumNodeRecord;
  path: CurriculumNodeRecord[];
};

export const curriculumSemanticKindSchema = z.enum([
  "knowledge_point",
  "knowledge",
  "method",
  "strategy",
  "capability",
  "learning_outcome",
  "misconception",
]);

export const curriculumSemanticRelationSchema = z.enum([
  "part_of",
  "prerequisite",
  "supports",
  "develops_into",
  "contrasts_with",
  "often_confused_with",
  "transfers_to",
]);

export const curriculumInstructionalRoleSchema = z.enum([
  "occurs_in",
  "introduces",
  "develops",
  "reinforces",
  "applies",
  "transfers",
  "assesses",
  "background",
]);

export type CurriculumSemanticKind = z.infer<typeof curriculumSemanticKindSchema>;
export type CurriculumSemanticRelation = z.infer<typeof curriculumSemanticRelationSchema>;
export type CurriculumInstructionalRole = z.infer<typeof curriculumInstructionalRoleSchema>;

export type CurriculumSemanticReleaseRecord = {
  id: string;
  scopeKey: string;
  catalogGenerationId: string;
  subject: string;
  stage: string;
  edition: string;
  grade: string;
  volume: string;
  schemaVersion: number;
  publishedAt: string;
};

export type CurriculumSemanticSource = SourceRef & {
  authority: string;
  locator?: string;
};

export type CurriculumSemanticEntityRecord = {
  id: string;
  externalId?: string;
  kind: CurriculumSemanticKind;
  canonicalName: string;
  definition: string;
  payload: Record<string, unknown>;
  confidence: number;
  sources: CurriculumSemanticSource[];
};

export type CurriculumNodeSemanticMapping = {
  id: string;
  instructionalRole: CurriculumInstructionalRole;
  expectedDepth: number;
  priority: number;
  confidence: number;
  rationale: string;
  entity: CurriculumSemanticEntityRecord;
  sources: CurriculumSemanticSource[];
};

export type CurriculumNodeSemanticsRecord = {
  release: CurriculumSemanticReleaseRecord | null;
  mappings: CurriculumNodeSemanticMapping[];
};

export type CurriculumSemanticLocation = {
  textbook: CurriculumTextbookRecord;
  node: CurriculumNodeRecord;
  instructionalRole: CurriculumInstructionalRole;
  expectedDepth: number;
};

export type CurriculumSemanticPathStep = {
  relationId: string;
  relationType: CurriculumSemanticRelation;
  depth: number;
  strength: number;
  confidence: number;
  rationale: string;
  fromEntity: CurriculumSemanticEntityRecord;
  toEntity: CurriculumSemanticEntityRecord;
  reachedEntity: CurriculumSemanticEntityRecord;
  locations: CurriculumSemanticLocation[];
  sources: CurriculumSemanticSource[];
};

export type CurriculumKnowledgePointOccurrence = {
  mappingId: string;
  nodeId: string;
  nodeTitle: string;
  pageNumber: number | null;
  sequenceNo: number;
  printedPages?: string;
  recommendedPeriod?: number;
  position?: "before" | "current" | "after";
  payload?: Record<string, unknown>;
};

export type CurriculumPeriodRecommendation = {
  id: string;
  periodNo: number;
  title: string;
  mappingType: string;
  isOfficial: boolean;
  note: string;
  pointIds: string[];
};

export type CurriculumNodeKnowledgePoint = {
  mappingId: string;
  sequenceNo: number;
  printedPages?: string;
  recommendedPeriod?: number;
  mappingPayload: Record<string, unknown>;
  point: CurriculumSemanticEntityRecord;
};

export type CurriculumNodeKnowledgeRecord = {
  release: CurriculumSemanticReleaseRecord | null;
  points: CurriculumNodeKnowledgePoint[];
  periodRecommendations: CurriculumPeriodRecommendation[];
};

export type CurriculumKnowledgeSearchResult = {
  point: CurriculumSemanticEntityRecord;
  score: number;
  retrievalMethod: "exact" | "embedding" | "lexical";
  occurrences: CurriculumKnowledgePointOccurrence[];
};

export type CurriculumKnowledgeContinuityRecord = {
  status: "available" | "unavailable" | "semantic_search_unavailable";
  currentSequenceNo: number | null;
  target?: CurriculumSemanticEntityRecord;
  candidates: CurriculumKnowledgeSearchResult[];
};

export type NormalizedAgentEvent =
  | { type: "run.started"; runId: string; threadId: string; branchId: string; startedAt?: string }
  | { type: "agent.started"; runId: string }
  | { type: "turn.started"; runId: string; turn: number }
  | { type: "assistant.message.started"; runId: string; turn: number }
  | { type: "assistant.message.ended"; runId: string; turn: number; outcome: "completed" | "failed" | "cancelled" }
  | { type: "turn.ended"; runId: string; turn: number; toolCount: number; outcome: "completed" | "failed" | "cancelled" }
  | { type: "agent.ended"; runId: string; turnCount: number; outcome: "completed" | "failed" | "cancelled" }
  // Legacy event names remain readable for already persisted runs. New Pi
  // projections use *.ended because a native end event is not proof that the
  // business run succeeded.
  | { type: "assistant.message.completed"; runId: string; turn: number }
  | { type: "turn.completed"; runId: string; turn: number; toolCount: number }
  | { type: "agent.completed"; runId: string; turnCount: number }
  | { type: "thread.updated"; runId: string; thread: AgentThreadRecord }
  | { type: "document.updated"; runId: string; file: LessonFileRecord }
  | { type: "document.draft"; runId: string; toolCallId: string; fileId: string; baseDocumentVersion: number; fields: Partial<Record<LessonField, string>> }
  | { type: "document.draft.discarded"; runId: string; toolCallId: string }
  | { type: "design_basis.updated"; runId: string; basis: LessonDesignBasisAggregate }
  | { type: "resource.updated"; runId: string; resourceType: "semester_framework"; framework: SemesterFrameworkAggregate }
  | { type: "message.delta"; runId: string; delta: string; turn?: number }
  | { type: "message.turn_text"; runId: string; turn: number; text: string }
  | {
    type: "agent.input.queued";
    runId: string;
    queueId: string;
    delivery: "steer" | "follow_up";
    content: string;
  }
  | {
    type: "agent.input.cleared";
    runId: string;
    delivery: "steer" | "follow_up" | "all";
  }
  | { type: "tool.started"; runId: string; toolCallId: string; name: string; label: string; detail?: string; groupKey?: string; turn?: number }
  | {
    type: "tool.updated";
    runId: string;
    toolCallId: string;
    name: string;
    label: string;
    detail?: string;
    groupKey?: string;
    turn?: number;
    progress?: { label: string; current?: number; total?: number };
  }
  | {
    type: "tool.completed";
    runId: string;
    toolCallId: string;
    name: string;
    ok: boolean;
    label: string;
    detail?: string;
    groupKey?: string;
    revisionCode?: string;
    turn?: number;
    /** Teacher-facing outcome; distinct from model-recoverable ok=false. */
    outcome?: "completed" | "no_change" | "needs_revision" | "failed";
  }
  | { type: "source.added"; runId: string; source: SourceRef }
  | {
    type: "approval.required";
    runId: string;
    approvalId: string;
    assistantMessageId?: string;
    toolCallId?: string;
    patch: ResourcePatch;
    /**
     * This event, not `run.completed`, ends the Agent's work for a proposing
     * run, so it carries that segment's transport timing. Without it the one
     * path whose latency the teacher actually waits on stays unmeasured.
     */
    transportTiming?: import("./agent-runtime/pi/transport-timing.js").PiTransportTiming;
  }
  | { type: "approval.decided"; runId: string; approvalId: string; decision: "approved" | "rejected" }
  | { type: "approval.settled"; runId: string; approvalId: string; decision: "approved" | "rejected" }
  | { type: "approval.failed"; runId: string; approvalId: string; error: string }
  | { type: "approval.delivered"; runId: string; approvalId: string; presentationId: string }
  | { type: "message.completed"; runId: string; message: AgentMessageRecord }
  | {
    type: "run.completed";
    runId: string;
    /** Safe aggregate timing emitted by the native Pi transport hooks. */
    transportTiming?: import("./agent-runtime/pi/transport-timing.js").PiTransportTiming;
  }
  | { type: "run.cancelled"; runId: string }
  | { type: "run.failed"; runId: string; error: string; message?: AgentMessageRecord }
  | { type: "learning.updated"; runId: string; lessonFileId: string; inquiryId: string };
