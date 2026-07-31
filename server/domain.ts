import { z } from "zod";

export const lessonFieldSchema = z.enum([
  "unit",
  "period",
  "totalPeriods",
  "topic",
  "objectives",
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

export const documentPatchSchema = z.object({
  fileId: z.string().min(1),
  baseDocumentVersion: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  operations: z.array(patchOperationSchema).min(1).max(32),
  citations: z.preprocess(
    (citations) => citations === null ? undefined : citations,
    z.array(sourceRefSchema).max(24).optional(),
  ),
});

const documentPatchToolOperationSchema = z.object({
  field: lessonFieldSchema,
  expectedText: z.string(),
  replacement: z.string(),
}).refine(
  (operation) => operation.expectedText !== operation.replacement,
  { message: "no_effect_patch" },
);

export const documentPatchToolSchema = z.object({
  summary: z.string().min(1).max(500),
  // Versions, offsets, context anchors and citations are server-owned.
  operations: z.array(documentPatchToolOperationSchema).min(1).max(32),
});

export type DocumentPatch = z.infer<typeof documentPatchSchema>;
export type DocumentPatchProposal = z.infer<typeof documentPatchToolSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;

export type LessonAgentSelection = {
  field: LessonField;
  start: number;
  end: number;
  text: string;
};

export type LessonAgentContext = {
  userId: string;
  notebookId: string;
  lessonFileId: string;
  threadId: string;
  branchId: string;
  runId: string;
  activeSectionId: string;
  selection?: LessonAgentSelection;
  documentVersion: number;
  contextProfile: LessonContextProfile;
  allowedKnowledgeScopes: string[];
  attachmentSourceIds: string[];
  abortSignal: AbortSignal;
};

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
  title: string;
  type: string;
  image?: string;
  document: LessonPlan;
  contextProfile: LessonContextProfile;
  documentVersion: number;
  pageCount: number;
  updatedAt: string;
};

export type LessonFileSummary = Omit<LessonFileRecord, "document" | "contextProfile">;

export type NotebookGraphRecord = NotebookRecord & {
  files: LessonFileSummary[];
};

export type AgentThreadRecord = {
  id: string;
  ownerId: string;
  notebookId: string;
  lessonFileId: string;
  title: string;
  status: "idle" | "running" | "awaiting_approval" | "failed";
  starterSuggestions?: string[];
  starterSuggestionsDocumentVersion?: number;
  archivedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentBranchRecord = {
  id: string;
  ownerId: string;
  threadId: string;
  parentBranchId?: string;
  forkedFromMessageId?: string;
  label: string;
  createdAt: string;
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
  sessionCursor?: number;
  createdAt: string;
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
  state: "pending" | "approved" | "rejected" | "expired";
  patch: DocumentPatch;
  encryptedRunState: string;
  agentDefinitionVersion: string;
  documentVersion: number;
  continuationStatus?: "pending" | "ready" | "running" | "completed";
  continuationLeaseToken?: string;
  continuationLeaseExpiresAt?: string;
  continuationAttemptCount?: number;
  continuationError?: string;
  continuationMessageId?: string;
  expiresAt: string;
  createdAt: string;
};

export type CapabilityPlan = {
  skillIds: string[];
  toolGroups: string[];
  mcpServers: string[];
  specialistAgents: string[];
  evidenceRequired: boolean;
  requiredEvidenceKinds?: AgentRunEvidenceKind[];
};

export type AgentRunEvidenceKind =
  | "knowledge_search"
  | "knowledge_passage"
  | "attachment_read"
  | "source_metadata"
  | "web_search"
  | "web_open"
  | "curriculum_textbook"
  | "curriculum_outline";

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

export type CurriculumNodeRecord = {
  textbookId: string;
  nodeId: string;
  parentId: string | null;
  level: number;
  sortNo: number;
  title: string;
  pageNumber: number | null;
};

export type CurriculumNodeMatch = {
  textbook: CurriculumTextbookRecord;
  node: CurriculumNodeRecord;
  path: CurriculumNodeRecord[];
};

export type NormalizedAgentEvent =
  | { type: "run.started"; runId: string; threadId: string; branchId: string }
  | { type: "thread.updated"; runId: string; thread: AgentThreadRecord }
  | { type: "document.updated"; runId: string; file: LessonFileRecord }
  | { type: "message.delta"; runId: string; delta: string }
  | { type: "tool.started"; runId: string; toolCallId: string; name: string; label: string; groupKey?: string }
  | { type: "tool.completed"; runId: string; toolCallId: string; name: string; ok: boolean; label: string; groupKey?: string }
  | { type: "source.added"; runId: string; source: SourceRef }
  | { type: "approval.required"; runId: string; approvalId: string; assistantMessageId?: string; patch: DocumentPatch }
  | { type: "approval.decided"; runId: string; approvalId: string; decision: "approved" | "rejected" }
  | { type: "message.completed"; runId: string; message: AgentMessageRecord }
  | { type: "run.completed"; runId: string }
  | { type: "run.cancelled"; runId: string }
  | { type: "run.failed"; runId: string; error: string };
