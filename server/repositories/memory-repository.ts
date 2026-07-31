import type { AgentInputItem } from "@openai/agents";
import { applyDocumentPatch, DocumentPatchError } from "../document-patch.js";
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
import type { CreateThreadInput, ImportedNotebook, LessonRepository } from "../repository.js";

let lastTimestamp = 0;
const now = () => {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return new Date(lastTimestamp).toISOString();
};
const key = (...parts: string[]) => parts.join(":");

export class MemoryLessonRepository implements LessonRepository {
  private notebooks = new Map<string, NotebookRecord>();
  private files = new Map<string, LessonFileRecord>();
  private threads = new Map<string, AgentThreadRecord>();
  private branches = new Map<string, AgentBranchRecord>();
  private messages = new Map<string, AgentMessageRecord>();
  private runs = new Map<string, AgentRunRecord>();
  private approvals = new Map<string, AgentApprovalRecord>();
  private sessionItems = new Map<string, AgentInputItem[]>();
  private threadMemories = new Map<string, { summary: string; cursor: number }>();
  private idempotency = new Map<string, {
    operation: "save_document" | "apply_approval";
    signature: string;
    file: LessonFileRecord;
  }>();
  private sessionAppendBatches = new Map<string, string>();
  private runEvents: Array<{ ownerId: string; runId: string; type: string; data: NormalizedAgentEvent }> = [];
  private lastMessageTimestamp = 0;

  private nextMessageTimestamp() {
    this.lastMessageTimestamp = Math.max(Date.now(), this.lastMessageTimestamp + 1);
    return new Date(this.lastMessageTimestamp).toISOString();
  }

  async importNotebookGraph(ownerId: string, notebooks: ImportedNotebook[]) {
    let imported = 0;
    for (const notebook of notebooks) {
      this.notebooks.set(key(ownerId, notebook.id), {
        id: notebook.id,
        ownerId,
        title: notebook.title,
        className: notebook.className,
        year: notebook.year,
        subject: notebook.subject,
        tone: notebook.tone ?? "teal",
        updatedAt: now(),
      });
      for (const file of notebook.files) {
        const fileKey = key(ownerId, file.id);
        if (!this.files.has(fileKey)) imported += 1;
        this.files.set(fileKey, {
          id: file.id,
          ownerId,
          notebookId: notebook.id,
          title: file.title,
          type: file.type ?? "教案",
          image: file.image,
          document: structuredClone(file.lessonPlan),
          documentVersion: this.files.get(fileKey)?.documentVersion ?? file.documentVersion ?? 0,
          pageCount: file.pages ?? 1,
          updatedAt: now(),
        });
      }
    }
    return { imported };
  }

  async listNotebooks(ownerId: string) {
    return [...this.notebooks.values()]
      .filter((notebook) => notebook.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((notebook) => ({
        ...structuredClone(notebook),
        files: [...this.files.values()]
          .filter((file) => file.ownerId === ownerId && file.notebookId === notebook.id)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map(({ document: _document, ...file }) => structuredClone(file)),
      }));
  }

  async createNotebook(ownerId: string, input: Parameters<LessonRepository["createNotebook"]>[1]) {
    const timestamp = now();
    const notebook: NotebookRecord = {
      id: crypto.randomUUID(),
      ownerId,
      ...input,
      updatedAt: timestamp,
    };
    this.notebooks.set(key(ownerId, notebook.id), notebook);
    return structuredClone(notebook);
  }

  async updateNotebook(
    ownerId: string,
    notebookId: string,
    patch: Parameters<LessonRepository["updateNotebook"]>[2],
  ) {
    const current = await this.getNotebook(ownerId, notebookId);
    if (!current) throw new Error("notebook_not_found");
    const updated = { ...current, ...patch, id: notebookId, ownerId, updatedAt: now() };
    this.notebooks.set(key(ownerId, notebookId), updated);
    return structuredClone(updated);
  }

  async deleteNotebook(ownerId: string, notebookId: string) {
    const current = await this.getNotebook(ownerId, notebookId);
    if (!current) throw new Error("notebook_not_found");
    this.notebooks.delete(key(ownerId, notebookId));
    for (const file of [...this.files.values()]) {
      if (file.ownerId === ownerId && file.notebookId === notebookId) {
        this.files.delete(key(ownerId, file.id));
      }
    }
  }

  async getNotebook(ownerId: string, notebookId: string) {
    return this.notebooks.get(key(ownerId, notebookId)) ?? null;
  }

  async createLessonFile(ownerId: string, input: Parameters<LessonRepository["createLessonFile"]>[1]) {
    const notebook = await this.getNotebook(ownerId, input.notebookId);
    if (!notebook) throw new Error("notebook_not_found");
    const timestamp = now();
    const file: LessonFileRecord = {
      id: crypto.randomUUID(),
      ownerId,
      notebookId: input.notebookId,
      title: input.title,
      type: input.type,
      image: input.image,
      document: structuredClone(input.document),
      documentVersion: 0,
      pageCount: input.pageCount,
      updatedAt: timestamp,
    };
    this.files.set(key(ownerId, file.id), file);
    await this.updateNotebook(ownerId, input.notebookId, {});
    return structuredClone(file);
  }

  async updateLessonFile(
    ownerId: string,
    fileId: string,
    patch: Parameters<LessonRepository["updateLessonFile"]>[2],
  ) {
    const current = await this.getLessonFile(ownerId, fileId);
    if (!current) throw new Error("lesson_file_not_found");
    const updated = { ...current, ...patch, id: fileId, ownerId, updatedAt: now() };
    this.files.set(key(ownerId, fileId), updated);
    await this.updateNotebook(ownerId, current.notebookId, {});
    return structuredClone(updated);
  }

  async deleteLessonFile(ownerId: string, fileId: string) {
    const current = await this.getLessonFile(ownerId, fileId);
    if (!current) throw new Error("lesson_file_not_found");
    this.files.delete(key(ownerId, fileId));
    await this.updateNotebook(ownerId, current.notebookId, {});
  }

  async getLessonFile(ownerId: string, fileId: string) {
    return this.files.get(key(ownerId, fileId)) ?? null;
  }

  async saveLessonDocument(args: Parameters<LessonRepository["saveLessonDocument"]>[0]) {
    const idempotencyKey = key(args.ownerId, args.idempotencyKey);
    const signature = JSON.stringify({
      fileId: args.fileId,
      baseVersion: args.baseVersion,
      document: args.document,
      pageCount: args.pageCount,
      source: args.source,
      runId: args.runId ?? null,
    });
    const replay = this.idempotency.get(idempotencyKey);
    if (replay) {
      if (replay.operation !== "save_document" || replay.signature !== signature) {
        throw new Error("idempotency_conflict");
      }
      return structuredClone(replay.file);
    }
    const current = await this.getLessonFile(args.ownerId, args.fileId);
    if (!current) throw new Error("lesson_file_not_found");
    if (current.documentVersion !== args.baseVersion) {
      throw new DocumentPatchError("stale_document", "教案已被继续编辑，请基于最新版本重试");
    }
    const updated: LessonFileRecord = {
      ...current,
      document: structuredClone(args.document),
      documentVersion: current.documentVersion + 1,
      pageCount: args.pageCount,
      updatedAt: now(),
    };
    this.files.set(key(args.ownerId, args.fileId), updated);
    this.idempotency.set(idempotencyKey, {
      operation: "save_document",
      signature,
      file: structuredClone(updated),
    });
    return updated;
  }

  async applyApprovedPatch(args: Parameters<LessonRepository["applyApprovedPatch"]>[0]) {
    const idempotencyKey = key(args.ownerId, args.idempotencyKey);
    const signature = JSON.stringify({ approvalId: args.approvalId });
    const replay = this.idempotency.get(idempotencyKey);
    if (replay) {
      if (replay.operation !== "apply_approval" || replay.signature !== signature) {
        throw new Error("idempotency_conflict");
      }
      return structuredClone(replay.file);
    }
    const approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.state !== "pending" && approval.state !== "approved") throw new Error("approval_not_approvable");
    const current = await this.getLessonFile(args.ownerId, approval.patch.fileId);
    if (!current) throw new Error("lesson_file_not_found");
    if (current.documentVersion !== approval.patch.baseDocumentVersion) {
      throw new DocumentPatchError("stale_document", "教案已被继续编辑，建议已过期");
    }
    const updated: LessonFileRecord = {
      ...current,
      document: applyDocumentPatch(current.document, approval.patch),
      documentVersion: current.documentVersion + 1,
      updatedAt: now(),
    };
    this.files.set(key(args.ownerId, current.id), updated);
    this.idempotency.set(idempotencyKey, {
      operation: "apply_approval",
      signature,
      file: structuredClone(updated),
    });
    await this.resolveApproval(args.ownerId, args.approvalId, "approved");
    return updated;
  }

  async listThreads(ownerId: string, lessonFileId: string, includeArchived = false) {
    return [...this.threads.values()]
      .filter((thread) => thread.ownerId === ownerId && thread.lessonFileId === lessonFileId)
      .filter((thread) => !thread.deletedAt && (includeArchived || !thread.archivedAt))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createThread(ownerId: string, input: CreateThreadInput) {
    const file = await this.getLessonFile(ownerId, input.lessonFileId);
    if (!file || file.notebookId !== input.notebookId) throw new Error("lesson_file_not_found");
    const timestamp = now();
    const thread: AgentThreadRecord = {
      id: crypto.randomUUID(), ownerId, notebookId: input.notebookId,
      lessonFileId: input.lessonFileId, title: input.title ?? "新会话", status: "idle",
      starterSuggestions: [],
      createdAt: timestamp, updatedAt: timestamp,
    };
    const branch: AgentBranchRecord = {
      id: crypto.randomUUID(), ownerId, threadId: thread.id, label: "主分支", createdAt: timestamp,
    };
    this.threads.set(thread.id, thread);
    this.branches.set(branch.id, branch);
    return { thread, branch };
  }

  async getThread(ownerId: string, threadId: string) {
    const thread = this.threads.get(threadId);
    return thread?.ownerId === ownerId && !thread.deletedAt ? thread : null;
  }

  async updateThread(ownerId: string, threadId: string, patch: Partial<AgentThreadRecord>) {
    const thread = await this.getThread(ownerId, threadId);
    if (!thread) throw new Error("thread_not_found");
    const updated = { ...thread, ...patch, id: thread.id, ownerId, updatedAt: now() };
    this.threads.set(threadId, updated);
    return updated;
  }

  async createBranch(ownerId: string, threadId: string, parentBranchId?: string, forkedFromMessageId?: string) {
    if (!await this.getThread(ownerId, threadId)) throw new Error("thread_not_found");
    const parentBranch = parentBranchId
      ? await this.getBranch(ownerId, threadId, parentBranchId)
      : null;
    if (parentBranchId && !parentBranch) throw new Error("parent_branch_not_found");
    const forkMessage = forkedFromMessageId
      ? this.messages.get(forkedFromMessageId)
      : null;
    if (forkedFromMessageId && (
      !forkMessage
      || forkMessage.ownerId !== ownerId
      || forkMessage.threadId !== threadId
      || forkMessage.branchId !== parentBranchId
    )) {
      throw new Error("fork_message_scope_invalid");
    }
    const forkCursor = forkMessage?.sessionCursor;
    const parentSession = parentBranchId
      ? this.sessionItems.get(key(ownerId, threadId, parentBranchId)) ?? []
      : [];
    if (forkCursor !== undefined && parentSession.length < forkCursor) {
      throw new Error("fork_session_not_committed");
    }
    const branch: AgentBranchRecord = {
      id: crypto.randomUUID(), ownerId, threadId, parentBranchId, forkedFromMessageId,
      label: `分支 ${[...this.branches.values()].filter((item) => item.threadId === threadId).length + 1}`,
      createdAt: now(),
    };
    this.branches.set(branch.id, branch);
    if (parentBranchId) {
      const parentMessages = [...this.messages.values()].filter((message) => (
        message.ownerId === ownerId
        && message.threadId === threadId
        && message.branchId === parentBranchId
      ));
      const forkIndex = forkedFromMessageId
        ? parentMessages.findIndex((message) => message.id === forkedFromMessageId)
        : parentMessages.length - 1;
      const inherited = parentMessages.slice(0, forkIndex + 1);
      for (const message of inherited) {
        await this.appendMessage({ ...message, id: undefined, branchId: branch.id });
      }
      const inheritedSession = forkCursor === undefined
        ? inherited.map((message) => ({
            type: "message",
            role: message.role,
            content: message.content,
          })) as AgentInputItem[]
        : structuredClone(parentSession.slice(0, forkCursor));
      this.sessionItems.set(key(ownerId, threadId, branch.id), inheritedSession);
      const parentMemory = this.threadMemories.get(key(ownerId, threadId, parentBranchId));
      if (parentMemory && forkCursor !== undefined && parentMemory.cursor <= forkCursor) {
        this.threadMemories.set(key(ownerId, threadId, branch.id), structuredClone(parentMemory));
      } else {
        this.threadMemories.delete(key(ownerId, threadId, branch.id));
      }
    }
    return branch;
  }

  async listBranches(ownerId: string, threadId: string) {
    return [...this.branches.values()]
      .filter((branch) => branch.ownerId === ownerId && branch.threadId === threadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getBranch(ownerId: string, threadId: string, branchId: string) {
    const branch = this.branches.get(branchId);
    return branch?.ownerId === ownerId && branch.threadId === threadId ? branch : null;
  }

  async listMessages(ownerId: string, threadId: string, branchId: string, cursor?: string, limit = 100) {
    const separator = cursor?.lastIndexOf("|") ?? -1;
    const cursorTime = separator > 0 ? cursor!.slice(0, separator) : cursor;
    const cursorId = separator > 0 ? cursor!.slice(separator + 1) : undefined;
    const values = [...this.messages.values()]
      .filter((message) => message.ownerId === ownerId && message.threadId === threadId && message.branchId === branchId)
      .filter((message) => !cursorTime
        || message.createdAt < cursorTime
        || (message.createdAt === cursorTime && cursorId !== undefined && message.id < cursorId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return values.slice(-limit);
  }

  async getMessage(ownerId: string, messageId: string) {
    const message = this.messages.get(messageId);
    return message?.ownerId === ownerId ? structuredClone(message) : null;
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
    const message: AgentMessageRecord = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      createdAt: this.nextMessageTimestamp(),
    };
    this.messages.set(message.id, message);
    await this.updateThread(input.ownerId, input.threadId, {});
    return message;
  }

  async updateMessage(ownerId: string, messageId: string, patch: Partial<AgentMessageRecord>) {
    const current = this.messages.get(messageId);
    if (!current || current.ownerId !== ownerId) throw new Error("message_not_found");
    const updated = { ...current, ...patch, id: current.id, ownerId };
    this.messages.set(messageId, updated);
    return updated;
  }

  async createRun(input: Omit<AgentRunRecord, "startedAt"> & { startedAt?: string }) {
    const run: AgentRunRecord = { ...input, startedAt: input.startedAt ?? now() };
    this.runs.set(run.id, run);
    return run;
  }

  async getRun(ownerId: string, runId: string) {
    const run = this.runs.get(runId);
    return run?.ownerId === ownerId ? run : null;
  }

  async getLatestRun(ownerId: string, threadId: string, branchId: string) {
    return [...this.runs.values()]
      .filter((run) => (
        run.ownerId === ownerId
        && run.threadId === threadId
        && run.branchId === branchId
      ))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
  }

  async updateRun(ownerId: string, runId: string, patch: Partial<AgentRunRecord>) {
    const run = await this.getRun(ownerId, runId);
    if (!run) throw new Error("run_not_found");
    const updated = { ...run, ...patch, id: runId, ownerId };
    this.runs.set(runId, updated);
    return updated;
  }

  async appendRunEvent(ownerId: string, runId: string, type: string, data: unknown) {
    this.runEvents.push({ ownerId, runId, type, data: data as NormalizedAgentEvent });
  }

  async listRunEvents(ownerId: string, runId: string) {
    return this.runEvents
      .filter((event) => event.ownerId === ownerId && event.runId === runId)
      .map((event) => structuredClone(event.data));
  }

  async saveApproval(approval: AgentApprovalRecord) { this.approvals.set(approval.id, approval); }

  async getApproval(ownerId: string, approvalId: string) {
    const approval = this.approvals.get(approvalId);
    return approval?.ownerId === ownerId ? approval : null;
  }

  async listApprovals(ownerId: string, threadId: string, branchId: string) {
    return [...this.approvals.values()]
      .filter((approval) => (
        approval.ownerId === ownerId
        && approval.threadId === threadId
        && approval.branchId === branchId
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((approval) => structuredClone(approval));
  }

  async listPendingApprovals(ownerId: string, threadId: string, branchId: string) {
    return [...this.approvals.values()].filter((approval) => (
      approval.ownerId === ownerId
      && approval.threadId === threadId
      && approval.branchId === branchId
      && (
        approval.state === "pending"
        || approval.continuationStatus === "ready"
        || approval.continuationStatus === "running"
      )
      && new Date(approval.expiresAt).getTime() > Date.now()
    ));
  }

  async resolveApproval(ownerId: string, approvalId: string, state: "approved" | "rejected" | "expired") {
    const approval = await this.getApproval(ownerId, approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.state !== "pending" && approval.state !== state) throw new Error("approval_already_resolved");
    const updated = { ...approval, state };
    this.approvals.set(approvalId, updated);
    return updated;
  }

  async decideApproval(args: {
    ownerId: string;
    approvalId: string;
    approved: boolean;
    encryptedRunState: string;
  }) {
    let approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.state === "expired" || new Date(approval.expiresAt).getTime() <= Date.now()) {
      throw new Error("approval_expired");
    }
    const desiredState = args.approved ? "approved" : "rejected";
    if (approval.state !== "pending" && approval.state !== desiredState) {
      throw new Error("approval_already_resolved");
    }

    let file: LessonFileRecord | null = null;
    if (approval.state === "pending") {
      if (args.approved) {
        file = await this.applyApprovedPatch({
          ownerId: args.ownerId,
          approvalId: args.approvalId,
          idempotencyKey: `approval:${args.approvalId}`,
        });
      } else {
        approval = await this.resolveApproval(args.ownerId, args.approvalId, "rejected");
      }
    } else if (args.approved) {
      file = await this.getLessonFile(args.ownerId, approval.patch.fileId);
    }

    approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    const updated: AgentApprovalRecord = {
      ...approval,
      state: desiredState,
      encryptedRunState: args.encryptedRunState,
      continuationStatus: approval.continuationStatus === "completed" ? "completed" : "ready",
      continuationLeaseToken: undefined,
      continuationLeaseExpiresAt: undefined,
      continuationError: undefined,
    };
    this.approvals.set(args.approvalId, updated);
    return { approval: structuredClone(updated), file: file ? structuredClone(file) : null };
  }

  async claimApprovalContinuation(args: {
    ownerId: string;
    approvalId: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }) {
    const approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.state === "pending") throw new Error("approval_decision_missing");
    if (approval.continuationStatus === "completed") return structuredClone(approval);
    const leaseActive = approval.continuationStatus === "running"
      && approval.continuationLeaseExpiresAt
      && new Date(approval.continuationLeaseExpiresAt).getTime() > Date.now();
    if (leaseActive) {
      throw new Error("active_run_exists");
    }
    const updated: AgentApprovalRecord = {
      ...approval,
      continuationStatus: "running",
      continuationLeaseToken: args.leaseToken,
      continuationLeaseExpiresAt: args.leaseExpiresAt,
      continuationAttemptCount: (approval.continuationAttemptCount ?? 0) + 1,
      continuationError: undefined,
      continuationMessageId: approval.continuationMessageId ?? crypto.randomUUID(),
    };
    this.approvals.set(args.approvalId, updated);
    return structuredClone(updated);
  }

  async finishApprovalContinuation(args: {
    ownerId: string;
    approvalId: string;
    leaseToken: string;
    status: "ready" | "completed";
    error?: string;
  }) {
    const approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (
      approval.continuationStatus === "running"
      && approval.continuationLeaseToken !== args.leaseToken
    ) {
      throw new Error("approval_lease_lost");
    }
    if (approval.continuationStatus === "completed") return structuredClone(approval);
    const updated: AgentApprovalRecord = {
      ...approval,
      continuationStatus: args.status,
      continuationLeaseToken: undefined,
      continuationLeaseExpiresAt: undefined,
      continuationError: args.error,
    };
    this.approvals.set(args.approvalId, updated);
    return structuredClone(updated);
  }

  async getSessionItems(ownerId: string, threadId: string, branchId: string, limit?: number) {
    const items = this.sessionItems.get(key(ownerId, threadId, branchId)) ?? [];
    return structuredClone(limit ? items.slice(-limit) : items);
  }

  async addSessionItems(
    ownerId: string,
    threadId: string,
    branchId: string,
    items: AgentInputItem[],
    idempotencyKey?: string,
  ) {
    const itemKey = key(ownerId, threadId, branchId);
    if (idempotencyKey) {
      const batchKey = key(itemKey, idempotencyKey);
      const payload = JSON.stringify(items);
      const existing = this.sessionAppendBatches.get(batchKey);
      if (existing !== undefined) {
        if (existing !== payload) throw new Error("idempotency_conflict");
        return;
      }
      this.sessionAppendBatches.set(batchKey, payload);
    }
    this.sessionItems.set(itemKey, [...(this.sessionItems.get(itemKey) ?? []), ...structuredClone(items)]);
  }

  async replaceSessionItems(
    ownerId: string,
    threadId: string,
    branchId: string,
    items: AgentInputItem[],
  ) {
    const itemKey = key(ownerId, threadId, branchId);
    this.sessionItems.set(itemKey, structuredClone(items));
    this.threadMemories.delete(itemKey);
    for (const batchKey of [...this.sessionAppendBatches.keys()]) {
      if (batchKey.startsWith(`${itemKey}:`)) this.sessionAppendBatches.delete(batchKey);
    }
  }

  async popSessionItem(ownerId: string, threadId: string, branchId: string) {
    const itemKey = key(ownerId, threadId, branchId);
    const items = this.sessionItems.get(itemKey) ?? [];
    const item = items.pop();
    this.sessionItems.set(itemKey, items);
    return item;
  }

  async clearSession(ownerId: string, threadId: string, branchId: string) {
    const itemKey = key(ownerId, threadId, branchId);
    this.sessionItems.delete(itemKey);
    for (const batchKey of [...this.sessionAppendBatches.keys()]) {
      if (batchKey.startsWith(`${itemKey}:`)) this.sessionAppendBatches.delete(batchKey);
    }
  }

  async getThreadMemory(ownerId: string, threadId: string, branchId: string) {
    return this.threadMemories.get(key(ownerId, threadId, branchId)) ?? null;
  }

  async saveThreadMemory(ownerId: string, threadId: string, branchId: string, summary: string, cursor: number) {
    this.threadMemories.set(key(ownerId, threadId, branchId), { summary, cursor });
  }
  async searchKnowledge(): Promise<KnowledgeResult[]> { return []; }
  async getKnowledgePassage(): Promise<KnowledgeResult | null> { return null; }
  async getKnowledgeSourcePassages(): Promise<KnowledgeResult[]> { return []; }
  async listProjectSources(): Promise<SourceRef[]> { return []; }
  async attachKnowledgeSources(
    _ownerId: string,
    _lessonFileId: string,
    _messageId: string,
    sourceIds: string[],
  ): Promise<SourceRef[]> {
    if (sourceIds.length) throw new Error("knowledge_attachment_unavailable");
    return [];
  }
}
