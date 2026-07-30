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
} from "../domain.js";
import type { CreateThreadInput, ImportedNotebook, LessonRepository } from "../repository.js";

const now = () => new Date().toISOString();
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
  private idempotency = new Map<string, LessonFileRecord>();
  private runEvents: Array<{ ownerId: string; runId: string; type: string; data: unknown }> = [];

  async importNotebookGraph(ownerId: string, notebooks: ImportedNotebook[]) {
    let imported = 0;
    for (const notebook of notebooks) {
      this.notebooks.set(key(ownerId, notebook.id), { ...notebook, ownerId });
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

  async getNotebook(ownerId: string, notebookId: string) {
    return this.notebooks.get(key(ownerId, notebookId)) ?? null;
  }

  async getLessonFile(ownerId: string, fileId: string) {
    return this.files.get(key(ownerId, fileId)) ?? null;
  }

  async saveLessonDocument(args: Parameters<LessonRepository["saveLessonDocument"]>[0]) {
    const replay = this.idempotency.get(key(args.ownerId, args.idempotencyKey));
    if (replay) return replay;
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
    this.idempotency.set(key(args.ownerId, args.idempotencyKey), updated);
    return updated;
  }

  async applyApprovedPatch(args: Parameters<LessonRepository["applyApprovedPatch"]>[0]) {
    const replay = this.idempotency.get(key(args.ownerId, args.idempotencyKey));
    if (replay) return replay;
    const approval = await this.getApproval(args.ownerId, args.approvalId);
    if (!approval) throw new Error("approval_not_found");
    if (approval.state !== "pending" && approval.state !== "approved") throw new Error("approval_not_approvable");
    const current = await this.getLessonFile(args.ownerId, approval.patch.fileId);
    if (!current) throw new Error("lesson_file_not_found");
    if (current.documentVersion !== approval.patch.baseDocumentVersion) {
      throw new DocumentPatchError("stale_document", "教案已被继续编辑，建议已过期");
    }
    const updated = await this.saveLessonDocument({
      ownerId: args.ownerId,
      fileId: current.id,
      baseVersion: current.documentVersion,
      document: applyDocumentPatch(current.document, approval.patch),
      pageCount: current.pageCount,
      source: "agent",
      runId: approval.runId,
      idempotencyKey: args.idempotencyKey,
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
    const branch: AgentBranchRecord = {
      id: crypto.randomUUID(), ownerId, threadId, parentBranchId, forkedFromMessageId,
      label: `分支 ${[...this.branches.values()].filter((item) => item.threadId === threadId).length + 1}`,
      createdAt: now(),
    };
    this.branches.set(branch.id, branch);
    if (parentBranchId) {
      const forkIndex = forkedFromMessageId
        ? [...this.messages.values()].filter((message) => message.branchId === parentBranchId)
          .findIndex((message) => message.id === forkedFromMessageId)
        : -1;
      const inherited = [...this.messages.values()]
        .filter((message) => message.ownerId === ownerId && message.threadId === threadId && message.branchId === parentBranchId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, forkIndex >= 0 ? forkIndex + 1 : undefined);
      for (const message of inherited) {
        await this.appendMessage({ ...message, id: undefined, branchId: branch.id });
      }
      const sourceItems = this.sessionItems.get(key(ownerId, threadId, parentBranchId)) ?? [];
      this.sessionItems.set(key(ownerId, threadId, branch.id), structuredClone(sourceItems));
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
    const values = [...this.messages.values()]
      .filter((message) => message.ownerId === ownerId && message.threadId === threadId && message.branchId === branchId)
      .filter((message) => !cursor || message.createdAt < cursor)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return values.slice(-limit);
  }

  async appendMessage(input: Omit<AgentMessageRecord, "id" | "createdAt"> & { id?: string }) {
    const message: AgentMessageRecord = { ...input, id: input.id ?? crypto.randomUUID(), createdAt: now() };
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

  async updateRun(ownerId: string, runId: string, patch: Partial<AgentRunRecord>) {
    const run = await this.getRun(ownerId, runId);
    if (!run) throw new Error("run_not_found");
    const updated = { ...run, ...patch, id: runId, ownerId };
    this.runs.set(runId, updated);
    return updated;
  }

  async appendRunEvent(ownerId: string, runId: string, type: string, data: unknown) {
    this.runEvents.push({ ownerId, runId, type, data });
  }

  async saveApproval(approval: AgentApprovalRecord) { this.approvals.set(approval.id, approval); }

  async getApproval(ownerId: string, approvalId: string) {
    const approval = this.approvals.get(approvalId);
    return approval?.ownerId === ownerId ? approval : null;
  }

  async listPendingApprovals(ownerId: string, threadId: string, branchId: string) {
    return [...this.approvals.values()].filter((approval) => (
      approval.ownerId === ownerId
      && approval.threadId === threadId
      && approval.branchId === branchId
      && approval.state === "pending"
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

  async getSessionItems(ownerId: string, threadId: string, branchId: string, limit?: number) {
    const items = this.sessionItems.get(key(ownerId, threadId, branchId)) ?? [];
    return structuredClone(limit ? items.slice(-limit) : items);
  }

  async addSessionItems(ownerId: string, threadId: string, branchId: string, items: AgentInputItem[]) {
    const itemKey = key(ownerId, threadId, branchId);
    this.sessionItems.set(itemKey, [...(this.sessionItems.get(itemKey) ?? []), ...structuredClone(items)]);
  }

  async popSessionItem(ownerId: string, threadId: string, branchId: string) {
    const itemKey = key(ownerId, threadId, branchId);
    const items = this.sessionItems.get(itemKey) ?? [];
    const item = items.pop();
    this.sessionItems.set(itemKey, items);
    return item;
  }

  async clearSession(ownerId: string, threadId: string, branchId: string) {
    this.sessionItems.delete(key(ownerId, threadId, branchId));
  }

  async getThreadMemory(ownerId: string, threadId: string, branchId: string) {
    return this.threadMemories.get(key(ownerId, threadId, branchId)) ?? null;
  }

  async saveThreadMemory(ownerId: string, threadId: string, branchId: string, summary: string, cursor: number) {
    this.threadMemories.set(key(ownerId, threadId, branchId), { summary, cursor });
  }
  async searchKnowledge(): Promise<KnowledgeResult[]> { return []; }
  async getKnowledgePassage(): Promise<KnowledgeResult | null> { return null; }
  async listProjectSources(): Promise<SourceRef[]> { return []; }
}
