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
});

export const documentPatchToolSchema = z.object({
  baseDocumentVersion: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  operations: z.array(patchOperationSchema).min(1).max(32),
  citations: z.array(sourceRefSchema).max(24).nullable(),
});

export type DocumentPatch = z.infer<typeof documentPatchSchema>;
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
  allowedKnowledgeScopes: string[];
  abortSignal: AbortSignal;
};

export type NotebookRecord = {
  id: string;
  ownerId: string;
  title: string;
  className: string;
  year: string;
  subject: string;
};

export type LessonFileRecord = {
  id: string;
  ownerId: string;
  notebookId: string;
  title: string;
  type: string;
  image?: string;
  document: LessonPlan;
  documentVersion: number;
  pageCount: number;
  updatedAt: string;
};

export type AgentThreadRecord = {
  id: string;
  ownerId: string;
  notebookId: string;
  lessonFileId: string;
  title: string;
  status: "idle" | "running" | "awaiting_approval" | "failed";
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
  status: "completed" | "streaming" | "failed";
  sources?: SourceRef[];
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
  tokenUsage?: Record<string, number>;
  providerCost?: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export type AgentApprovalRecord = {
  id: string;
  ownerId: string;
  runId: string;
  threadId: string;
  branchId: string;
  state: "pending" | "approved" | "rejected" | "expired";
  patch: DocumentPatch;
  encryptedRunState: string;
  agentDefinitionVersion: string;
  documentVersion: number;
  expiresAt: string;
  createdAt: string;
};

export type CapabilityPlan = {
  skillIds: string[];
  toolGroups: string[];
  mcpServers: string[];
  specialistAgents: string[];
};

export type KnowledgeResult = SourceRef & {
  passage: string;
  score: number;
  section?: string;
};

export type NormalizedAgentEvent =
  | { type: "run.started"; runId: string; threadId: string; branchId: string }
  | { type: "message.delta"; runId: string; delta: string }
  | { type: "tool.started"; runId: string; toolCallId: string; name: string; label: string; groupKey?: string }
  | { type: "tool.completed"; runId: string; toolCallId: string; name: string; ok: boolean; label: string; groupKey?: string }
  | { type: "source.added"; runId: string; source: SourceRef }
  | { type: "approval.required"; runId: string; approvalId: string; patch: DocumentPatch }
  | { type: "message.completed"; runId: string; message: AgentMessageRecord }
  | { type: "run.completed"; runId: string }
  | { type: "run.cancelled"; runId: string }
  | { type: "run.failed"; runId: string; error: string };
