import type { AgentInputItem } from "@openai/agents";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AgentApprovalRecord,
  AgentBranchRecord,
  AgentMessageRecord,
  AgentRunRecord,
  AgentThreadRecord,
  KnowledgeResult,
  LessonFileRecord,
  NotebookRecord,
  SourceRef,
  NormalizedAgentEvent,
} from "../domain.js";
import { lessonPlanSchema } from "../domain.js";
import type { CreateThreadInput, ImportedNotebook, LessonRepository } from "../repository.js";

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data == null) throw new Error("record_not_found");
  return result.data;
}

const mapThread = (row: Record<string, any>): AgentThreadRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  notebookId: row.notebook_id,
  lessonFileId: row.lesson_file_id,
  title: row.title,
  status: row.status,
  starterSuggestions: row.starter_suggestions ?? [],
  starterSuggestionsDocumentVersion: row.starter_suggestions_document_version == null
    ? undefined
    : Number(row.starter_suggestions_document_version),
  archivedAt: row.archived_at ?? undefined,
  deletedAt: row.deleted_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapBranch = (row: Record<string, any>): AgentBranchRecord => ({
  id: row.id, ownerId: row.owner_id, threadId: row.thread_id,
  parentBranchId: row.parent_branch_id ?? undefined,
  forkedFromMessageId: row.forked_from_message_id ?? undefined,
  label: row.label, createdAt: row.created_at,
});

const mapMessage = (row: Record<string, any>): AgentMessageRecord => ({
  id: row.id, ownerId: row.owner_id, threadId: row.thread_id, branchId: row.branch_id,
  role: row.role, content: row.content, status: row.status,
  sources: row.sources ?? undefined,
  sessionCursor: row.session_cursor == null ? undefined : Number(row.session_cursor),
  createdAt: row.created_at,
});

const mapRun = (row: Record<string, any>): AgentRunRecord => ({
  id: row.id, ownerId: row.owner_id, threadId: row.thread_id, branchId: row.branch_id,
  model: row.model, status: row.status, capabilityPlan: row.capability_plan ?? undefined,
  agentDefinitionVersion: row.agent_definition_version ?? undefined,
  skillVersions: row.skill_versions ?? undefined,
  tokenUsage: row.token_usage ?? undefined,
  providerCost: row.provider_cost == null ? undefined : Number(row.provider_cost),
  error: row.error ?? undefined, startedAt: row.started_at, completedAt: row.completed_at ?? undefined,
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
  documentVersion: row.document_version,
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
  title: row.title, type: row.type, image: row.image ?? undefined,
  document: lessonPlanSchema.parse(row.document), documentVersion: row.document_version,
  pageCount: row.page_count, updatedAt: row.updated_at,
});

const mapNotebook = (row: Record<string, any>): NotebookRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  title: row.title,
  className: row.class_name,
  year: row.year,
  subject: row.subject,
  tone: row.tone ?? "teal",
  updatedAt: row.updated_at,
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
        .select("id,owner_id,notebook_id,title,type,image,document_version,page_count,updated_at")
        .eq("owner_id", ownerId).order("updated_at", { ascending: false }),
    ]);
    if (notebooks.error) throw new Error(notebooks.error.message);
    if (files.error) throw new Error(files.error.message);
    const mappedFiles = (files.data ?? []).map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      notebookId: row.notebook_id,
      title: row.title,
      type: row.type,
      image: row.image ?? undefined,
      documentVersion: row.document_version,
      pageCount: row.page_count,
      updatedAt: row.updated_at,
    }));
    return (notebooks.data ?? []).map((row) => {
      const notebook = mapNotebook(row);
      return {
        ...notebook,
        files: mappedFiles.filter((file) => file.notebookId === notebook.id),
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

  async createLessonFile(ownerId: string, input: Parameters<LessonRepository["createLessonFile"]>[1]) {
    const result = await this.client.rpc("create_lesson_file", {
      p_owner_id: ownerId,
      p_file_id: crypto.randomUUID(),
      p_notebook_id: input.notebookId,
      p_title: input.title,
      p_type: input.type,
      p_image: input.image ?? null,
      p_document: input.document,
      p_page_count: input.pageCount,
      p_idempotency_key: `create:${crypto.randomUUID()}`,
    });
    return mapFile(unwrap(result as any));
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

  async saveLessonDocument(args: Parameters<LessonRepository["saveLessonDocument"]>[0]) {
    const result = await this.client.rpc("save_lesson_document", {
      p_owner_id: args.ownerId, p_file_id: args.fileId, p_base_version: args.baseVersion,
      p_document: args.document, p_page_count: args.pageCount, p_source: args.source,
      p_run_id: args.runId ?? null, p_idempotency_key: args.idempotencyKey,
    });
    return mapFile(unwrap(result as any));
  }

  async applyApprovedPatch(args: Parameters<LessonRepository["applyApprovedPatch"]>[0]) {
    const result = await this.client.rpc("apply_approved_document_patch", {
      p_owner_id: args.ownerId, p_approval_id: args.approvalId,
      p_idempotency_key: args.idempotencyKey,
    });
    return mapFile(unwrap(result as any));
  }

  async listThreads(ownerId: string, lessonFileId: string, includeArchived = false) {
    let query = this.client.from("agent_threads").select("*")
      .eq("owner_id", ownerId).eq("lesson_file_id", lessonFileId).is("deleted_at", null);
    if (!includeArchived) query = query.is("archived_at", null);
    const result = await query.order("updated_at", { ascending: false });
    if (result.error) throw new Error(result.error.message);
    return (result.data ?? []).map(mapThread);
  }

  async createThread(ownerId: string, input: CreateThreadInput) {
    const file = await this.getLessonFile(ownerId, input.lessonFileId);
    if (!file || file.notebookId !== input.notebookId) throw new Error("lesson_file_not_found");
    const threadResult = await this.client.from("agent_threads").insert({
      owner_id: ownerId, notebook_id: input.notebookId, lesson_file_id: input.lessonFileId,
      title: input.title ?? "新会话",
    }).select("*").single();
    const thread = mapThread(unwrap(threadResult as any));
    const branchResult = await this.client.from("agent_branches").insert({
      owner_id: ownerId, thread_id: thread.id, label: "主分支",
    }).select("*").single();
    return { thread, branch: mapBranch(unwrap(branchResult as any)) };
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
    return (result.data ?? []).reverse().map(mapMessage);
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
      content: patch.content, status: patch.status, sources: patch.sources,
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
      token_usage: input.tokenUsage,
      provider_cost: input.providerCost,
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

  async updateRun(ownerId: string, runId: string, patch: Partial<AgentRunRecord>) {
    const result = await this.client.from("agent_runs").update({
      status: patch.status, capability_plan: patch.capabilityPlan,
      agent_definition_version: patch.agentDefinitionVersion,
      skill_versions: patch.skillVersions,
      token_usage: patch.tokenUsage,
      provider_cost: patch.providerCost,
      error: patch.error, completed_at: patch.completedAt,
    }).eq("owner_id", ownerId).eq("id", runId).select("*").single();
    return mapRun(unwrap(result as any));
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
      document_version: approval.documentVersion, expires_at: approval.expiresAt,
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
    const payload = unwrap(result as any) as { approval: Record<string, any>; file: Record<string, any> | null };
    return {
      approval: mapApproval(payload.approval),
      file: payload.file ? mapFile(payload.file) : null,
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
}
