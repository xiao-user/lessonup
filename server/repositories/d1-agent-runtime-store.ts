import type {
  AgentApprovalRecord,
  AgentBranchRecord,
  AgentMessageRecord,
  AgentResourceRef,
  AgentRunRecord,
  AgentThreadRecord,
  NormalizedAgentEvent,
  ResourcePatch,
  SourceRef,
} from "../domain.js";
import { persistedActivitiesFromEvents, persistedTurnPhaseFromEvents, persistedTurnTextsFromEvents } from "../agent-activity-presentation.js";
import type {
  AgentRuntimeName,
  AgentRuntimeSessionSnapshot,
  AgentSessionItem,
  ConversationSnapshot,
  CreateThreadInput,
  LessonRepository,
  PresentationTaskOwnerInput,
} from "../repository.js";
import type { SqlDatabase, SqlStatement, SqlValue } from "../platform/sql-database.js";
import { runtimeSessionWritePlan } from "./runtime-session-persist.js";

type ThreadRow = Record<string, unknown>;
type BranchRow = Record<string, unknown>;
type MessageRow = Record<string, unknown>;
type RunRow = Record<string, unknown>;

/**
 * The durable Agent protocol slice. It intentionally has no Cloudflare types:
 * D1 is supplied through SqlDatabase, so a PostgreSQL implementation can keep
 * the coordinator and all callers unchanged.
 */
export type AgentRuntimeStore = Pick<LessonRepository,
  "listThreads" | "createThread" | "getThread" | "getConversationSnapshot" | "updateThread" |
  "createBranch" | "listBranches" | "getBranch" | "updateBranch" | "bindPresentationTheme" | "updatePresentationTask" |
  "listMessages" | "getMessage" | "appendMessage" | "updateMessage" |
  "createRun" | "createRunWithInitialMessages" | "getRun" | "getRunByClientCommand" | "getLatestRun" | "getLatestCompletedRun" |
  "updateRun" | "heartbeatRun" | "settleRun" | "requestRunCancellation" |
  "recoverExpiredRuns" | "appendRunEvent" | "listRunEvents" |
  "getSessionItems" | "getSessionItemsAfter" | "getSessionItemCount" |
  "addSessionItems" | "replaceSessionItems" | "popSessionItem" | "clearSession" |
  "getAgentRuntimeSession" | "saveAgentRuntimeSession" |
  "getThreadMemory" | "saveThreadMemory">;

export class D1AgentRuntimeStore implements AgentRuntimeStore {
  constructor(private readonly database: SqlDatabase, private readonly clock = () => new Date().toISOString()) {}

  async listThreads(ownerId: string, resource: string | AgentResourceRef, includeArchived = false) {
    const scope = typeof resource === "string"
      ? { resourceType: "lesson_file" as const, lessonFileId: resource }
      : resource;
    const clauses = ["owner_id = ?", "resource_type = ?", "deleted_at IS NULL"];
    const params: SqlValue[] = [ownerId, scope.resourceType];
    if (scope.resourceType === "lesson_file") { clauses.push("lesson_file_id = ?"); params.push(scope.lessonFileId); }
    else { clauses.push("semester_framework_id = ?"); params.push(scope.semesterFrameworkId); }
    if (!includeArchived) clauses.push("archived_at IS NULL");
    const result = await this.database.query<ThreadRow>({
      sql: `${threadSelect} WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC`, params,
    });
    return result.rows.map(thread);
  }

  async createThread(ownerId: string, input: CreateThreadInput, idempotencyKey = crypto.randomUUID()) {
    const fingerprint = JSON.stringify(input);
    const replay = await this.replay<{ thread: AgentThreadRecord; branch: AgentBranchRecord }>(ownerId, "create_agent_thread", idempotencyKey, fingerprint);
    if (replay) return replay;
    const resource: AgentResourceRef = input.resourceType === "semester_framework"
      ? { resourceType: "semester_framework", semesterFrameworkId: input.semesterFrameworkId }
      : { resourceType: "lesson_file", lessonFileId: input.lessonFileId };
    const file = await this.database.query<{ id: string }>({
      sql: `SELECT id FROM ${resource.resourceType === "lesson_file" ? "lesson_files" : "semester_frameworks"} WHERE owner_id = ? AND notebook_id = ? AND id = ?`,
      params: [ownerId, input.notebookId, resource.resourceType === "lesson_file" ? resource.lessonFileId : resource.semesterFrameworkId],
    });
    if (!file.rows[0]) throw new Error(resource.resourceType === "lesson_file" ? "lesson_file_not_found" : "semester_framework_not_found");
    const timestamp = this.clock();
    const record: AgentThreadRecord = { id: crypto.randomUUID(), ownerId, notebookId: input.notebookId, ...resource,
      title: input.title ?? "新会话", status: "idle", starterSuggestions: [], createdAt: timestamp, updatedAt: timestamp };
    const branch: AgentBranchRecord = { id: crypto.randomUUID(), ownerId, threadId: record.id, label: "主分支", createdAt: timestamp };
    await this.database.batch([
      { sql: `INSERT INTO agent_threads (id, owner_id, notebook_id, resource_type, lesson_file_id, semester_framework_id, title, status, starter_suggestions_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [record.id, ownerId, record.notebookId, record.resourceType, record.resourceType === "lesson_file" ? record.lessonFileId : null, record.resourceType === "semester_framework" ? record.semesterFrameworkId : null, record.title, record.status, "[]", timestamp, timestamp] },
      { sql: "INSERT INTO agent_branches (id, owner_id, thread_id, label, created_at) VALUES (?, ?, ?, ?, ?)", params: [branch.id, ownerId, record.id, branch.label, timestamp] },
      ...this.storeReplay(ownerId, "create_agent_thread", idempotencyKey, fingerprint, { thread: record, branch }, timestamp),
    ]);
    return { thread: record, branch };
  }

  async getThread(ownerId: string, threadId: string) {
    const result = await this.database.query<ThreadRow>({ sql: `${threadSelect} WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`, params: [ownerId, threadId] });
    return result.rows[0] ? thread(result.rows[0]) : null;
  }

  /**
   * Reads every durable fact needed to restore one selected conversation in a
   * single database batch. D1 executes the batch as one transaction, so the UI
   * never combines a thread from before settlement with messages from after it.
   */
  async getConversationSnapshot(
    ownerId: string,
    threadId: string,
    branchId: string,
  ): Promise<ConversationSnapshot | null> {
    const results = await this.database.batch([
      { sql: `${threadSelect} WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`, params: [ownerId, threadId] },
      { sql: `${branchSelect} WHERE owner_id = ? AND thread_id = ? AND id = ?`, params: [ownerId, threadId, branchId] },
      { sql: `${branchSelect} WHERE owner_id = ? AND thread_id = ? ORDER BY created_at, id`, params: [ownerId, threadId] },
      { sql: `${messageSelect} WHERE owner_id = ? AND thread_id = ? AND branch_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`, params: [ownerId, threadId, branchId] },
      { sql: `${runSelect} WHERE owner_id = ? AND thread_id = ? AND branch_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`, params: [ownerId, threadId, branchId] },
      { sql: `${runSelect} WHERE owner_id = ? AND assistant_message_id IN (
          SELECT id FROM agent_messages
          WHERE owner_id = ? AND thread_id = ? AND branch_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 100
        ) ORDER BY started_at DESC, id DESC`, params: [ownerId, ownerId, threadId, branchId] },
      { sql: `SELECT run_id, data_json, sequence_no FROM agent_events
        WHERE owner_id = ? AND (
          run_id IN (
            SELECT id FROM agent_runs
            WHERE owner_id = ? AND assistant_message_id IN (
              SELECT id FROM agent_messages
              WHERE owner_id = ? AND thread_id = ? AND branch_id = ?
              ORDER BY created_at DESC, id DESC LIMIT 100
            )
          )
          OR run_id = (
            SELECT id FROM agent_runs
            WHERE owner_id = ? AND thread_id = ? AND branch_id = ?
            ORDER BY started_at DESC, id DESC LIMIT 1
          )
        ) ORDER BY run_id, sequence_no`, params: [
          ownerId, ownerId, ownerId, threadId, branchId,
          ownerId, threadId, branchId,
        ] },
      { sql: `${approvalSelectForSnapshot} WHERE owner_id = ? AND thread_id = ? AND branch_id = ? ORDER BY created_at, id`, params: [ownerId, threadId, branchId] },
    ]);
    const threadRow = results[0]?.rows[0];
    const branchRow = results[1]?.rows[0];
    if (!threadRow || !branchRow) return null;
    const latestRun = results[4]?.rows[0] ? run(results[4].rows[0]) : null;
    const eventsByRun = new Map<string, NormalizedAgentEvent[]>();
    let throughSequence = 0;
    for (const row of results[6]?.rows ?? []) {
      const runId = String(row.run_id);
      const values = eventsByRun.get(runId) ?? [];
      values.push(JSON.parse(String(row.data_json)) as NormalizedAgentEvent);
      eventsByRun.set(runId, values);
      if (runId === latestRun?.id) throughSequence = Math.max(throughSequence, Number(row.sequence_no ?? 0));
    }
    const runByMessage = new Map<string, AgentRunRecord>();
    for (const row of results[5]?.rows ?? []) {
      const value = run(row);
      if (value.assistantMessageId && !runByMessage.has(value.assistantMessageId)) {
        runByMessage.set(value.assistantMessageId, value);
      }
    }
    const messages = [...(results[3]?.rows ?? [])].reverse().map((row) => {
      const value = message(row);
      const owningRun = runByMessage.get(value.id);
      if (!owningRun) return value;
      const runEvents = eventsByRun.get(owningRun.id) ?? [];
      return {
        ...value,
        activities: persistedActivitiesFromEvents(runEvents, owningRun.status),
        turnTexts: persistedTurnTextsFromEvents(runEvents),
        turn: {
          runId: owningRun.id,
          status: owningRun.status,
          ...persistedTurnPhaseFromEvents(runEvents, owningRun.status),
          startedAt: owningRun.startedAt,
          completedAt: owningRun.completedAt,
        },
      };
    });
    const capturedAt = this.clock();
    const threadValue = thread(threadRow);
    return {
      schemaVersion: 1,
      capturedAt,
      aggregateVersion: [threadValue.updatedAt, latestRun?.id ?? "none", latestRun?.status ?? "idle", throughSequence].join(":"),
      thread: threadValue,
      branch: branch(branchRow),
      branches: (results[2]?.rows ?? []).map(branch),
      messages,
      latestRun,
      events: latestRun ? eventsByRun.get(latestRun.id) ?? [] : [],
      throughSequence,
      approvals: (results[7]?.rows ?? []).map(approvalFromSnapshot),
    };
  }

  async updateThread(ownerId: string, threadId: string, patch: Parameters<LessonRepository["updateThread"]>[2]) {
    const columns: Record<string, string> = { title: "title", archivedAt: "archived_at", deletedAt: "deleted_at", status: "status", starterSuggestions: "starter_suggestions_json", starterSuggestionsDocumentVersion: "starter_suggestions_document_version", starterSuggestionsResourceVersion: "starter_suggestions_resource_version" };
    const { assignments, params } = updateParts(patch, columns, (key, value) => key === "starterSuggestions" ? JSON.stringify(value) : value as SqlValue);
    assignments.push("updated_at = ?"); params.push(this.clock(), ownerId, threadId);
    const result = await this.database.query({ sql: `UPDATE agent_threads SET ${assignments.join(", ")} WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`, params });
    if (!result.rowsAffected) throw new Error("thread_not_found");
    return (await this.getThread(ownerId, threadId))!;
  }

  async createBranch(ownerId: string, threadId: string, parentBranchId?: string, forkedFromMessageId?: string) {
    if (!await this.getThread(ownerId, threadId)) throw new Error("thread_not_found");
    if (parentBranchId && !await this.getBranch(ownerId, threadId, parentBranchId)) throw new Error("parent_branch_not_found");
    let forkCursor: number | undefined;
    if (forkedFromMessageId) {
      const message = await this.database.query<MessageRow>({ sql: `${messageSelect} WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND id = ?`, params: [ownerId, threadId, parentBranchId ?? "", forkedFromMessageId] });
      if (!message.rows[0]) throw new Error("fork_message_scope_invalid");
      forkCursor = numberOrUndefined(message.rows[0].session_cursor);
    }
    const count = await this.database.query<{ total: number }>({ sql: "SELECT COUNT(*) AS total FROM agent_branches WHERE owner_id = ? AND thread_id = ?", params: [ownerId, threadId] });
    const record: AgentBranchRecord = { id: crypto.randomUUID(), ownerId, threadId, parentBranchId, forkedFromMessageId, label: `分支 ${(count.rows[0]?.total ?? 0) + 1}`, createdAt: this.clock() };
    await this.database.query({ sql: "INSERT INTO agent_branches (id, owner_id, thread_id, parent_branch_id, forked_from_message_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [record.id, ownerId, threadId, parentBranchId ?? null, forkedFromMessageId ?? null, record.label, record.createdAt] });
    if (parentBranchId) {
      await this.copyForkHistory(ownerId, threadId, parentBranchId, record.id, forkedFromMessageId, forkCursor);
      await this.copyPiRuntimeSession(ownerId, threadId, parentBranchId, record.id, forkCursor);
    }
    return record;
  }

  async listBranches(ownerId: string, threadId: string) {
    const result = await this.database.query<BranchRow>({ sql: `${branchSelect} WHERE owner_id = ? AND thread_id = ? ORDER BY created_at, id`, params: [ownerId, threadId] });
    return result.rows.map(branch);
  }

  async getBranch(ownerId: string, threadId: string, branchId: string) {
    const result = await this.database.query<BranchRow>({ sql: `${branchSelect} WHERE owner_id = ? AND thread_id = ? AND id = ?`, params: [ownerId, threadId, branchId] });
    return result.rows[0] ? branch(result.rows[0]) : null;
  }

  async updateBranch(ownerId: string, threadId: string, branchId: string, patch: Parameters<LessonRepository["updateBranch"]>[3]) {
    const value = patch.pendingInteraction === undefined ? undefined : JSON.stringify(patch.pendingInteraction);
    if (value === undefined) return this.requireBranch(ownerId, threadId, branchId);
    const result = await this.database.query({ sql: "UPDATE agent_branches SET pending_interaction_json = ? WHERE owner_id = ? AND thread_id = ? AND id = ?", params: [value, ownerId, threadId, branchId] });
    if (!result.rowsAffected) throw new Error("branch_not_found");
    return this.requireBranch(ownerId, threadId, branchId);
  }

  async bindPresentationTheme(args: Parameters<LessonRepository["bindPresentationTheme"]>[0]): Promise<boolean> {
    const { expectedPending, theme } = args;
    if (expectedPending.kind !== "presentation_generation"
      || expectedPending.resourceId !== args.fileId
      || expectedPending.documentVersion !== args.documentVersion
      || !theme.trim() || theme !== theme.trim()
      || (expectedPending.confirmedTheme !== undefined && expectedPending.confirmedTheme !== theme)) return false;
    return this.compareAndSetPresentationTask(args, JSON.stringify({ ...expectedPending, confirmedTheme: theme }));
  }

  /** Ordinary chat can preserve, mark or clear a presentation task, but the
   * same run-lease and snapshot guards apply so a cancelled or replaced run
   * cannot write a late task over the current one. */
  async updatePresentationTask(args: Parameters<LessonRepository["updatePresentationTask"]>[0]): Promise<boolean> {
    const { previousPending, pendingInteraction } = args;
    // The previous task is the CAS identity, even when it belongs to an older
    // document version. The owning run and the new task must use the current
    // canonical snapshot; this permits safe stale-task cleanup and replacement.
    if (previousPending?.resourceId !== undefined && previousPending.resourceId !== args.fileId) return false;
    if (pendingInteraction && (
      pendingInteraction.resourceId !== args.fileId
      || pendingInteraction.documentVersion !== args.documentVersion)) return false;
    return this.compareAndSetPresentationTask(
      { ...args, expectedPending: previousPending },
      pendingInteraction ? JSON.stringify(pendingInteraction) : null,
    );
  }

  private async compareAndSetPresentationTask(
    args: PresentationTaskOwnerInput,
    pendingJson: string | null,
  ): Promise<boolean> {
    const result = await this.database.query({
      sql: `UPDATE agent_branches
        SET pending_interaction_json = ?
        WHERE owner_id = ? AND thread_id = ? AND id = ?
          AND COALESCE(pending_interaction_json, 'null') = ?
          AND EXISTS (
            SELECT 1 FROM agent_runs r
            JOIN agent_threads t ON t.id = r.thread_id AND t.owner_id = r.owner_id
            JOIN lesson_files f ON f.id = t.lesson_file_id AND f.owner_id = t.owner_id AND f.notebook_id = t.notebook_id
            JOIN notebooks n ON n.id = f.notebook_id AND n.owner_id = f.owner_id
            WHERE r.owner_id = agent_branches.owner_id
              AND r.thread_id = agent_branches.thread_id AND r.branch_id = agent_branches.id
              AND r.id = ? AND r.status = 'running' AND r.lease_token = ?
              AND r.cancel_requested_at IS NULL AND r.lease_expires_at > ?
              AND t.resource_type = 'lesson_file' AND t.deleted_at IS NULL
              AND f.id = ? AND f.document_version = ?
          )`,
      params: [pendingJson, args.ownerId, args.threadId, args.branchId, JSON.stringify(args.expectedPending),
        args.runId, args.leaseToken, this.clock(), args.fileId, args.documentVersion],
    });
    return result.rowsAffected === 1;
  }

  async listMessages(ownerId: string, threadId: string, branchId: string, cursor?: string, limit = 100) {
    const { clause, params } = messageCursor(cursor);
    const result = await this.database.query<MessageRow>({ sql: `${messageSelect} WHERE owner_id = ? AND thread_id = ? AND branch_id = ? ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`, params: [ownerId, threadId, branchId, ...params, limit] });
    const messages = result.rows.reverse().map(message);
    return this.withRunPresentation(ownerId, messages);
  }

  async getMessage(ownerId: string, messageId: string) {
    const result = await this.database.query<MessageRow>({ sql: `${messageSelect} WHERE owner_id = ? AND id = ?`, params: [ownerId, messageId] });
    return result.rows[0] ? message(result.rows[0]) : null;
  }

  async appendMessage(input: Parameters<LessonRepository["appendMessage"]>[0]) {
    if (input.id) { const existing = await this.getMessage(input.ownerId, input.id); if (existing) {
      if (existing.threadId !== input.threadId || existing.branchId !== input.branchId || existing.role !== input.role) throw new Error("idempotency_conflict");
      return existing;
    } }
    if (!await this.getBranch(input.ownerId, input.threadId, input.branchId)) throw new Error("branch_not_found");
    const record: AgentMessageRecord = { ...input, id: input.id ?? crypto.randomUUID(), createdAt: this.clock() };
    await this.database.batch([
      { sql: `INSERT INTO agent_messages (id, owner_id, thread_id, branch_id, role, content, status, error, sources_json, session_cursor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [record.id, record.ownerId, record.threadId, record.branchId, record.role, record.content, record.status, record.error ?? null, JSON.stringify(record.sources ?? []), record.sessionCursor ?? null, record.createdAt] },
      { sql: "UPDATE agent_threads SET updated_at = ? WHERE owner_id = ? AND id = ?", params: [record.createdAt, record.ownerId, record.threadId] },
    ]);
    return record;
  }

  async updateMessage(ownerId: string, messageId: string, patch: Parameters<LessonRepository["updateMessage"]>[2]) {
    const columns: Record<string, string> = { content: "content", status: "status", error: "error", sources: "sources_json", sessionCursor: "session_cursor" };
    const { assignments, params } = updateParts(patch, columns, (key, value) => key === "sources" ? JSON.stringify(value) : value as SqlValue);
    if (!assignments.length) return this.requireMessage(ownerId, messageId);
    params.push(ownerId, messageId);
    const result = await this.database.query({ sql: `UPDATE agent_messages SET ${assignments.join(", ")} WHERE owner_id = ? AND id = ?`, params });
    if (!result.rowsAffected) throw new Error("message_not_found");
    return this.requireMessage(ownerId, messageId);
  }

  async createRun(input: Parameters<LessonRepository["createRun"]>[0]) {
    if (!await this.getBranch(input.ownerId, input.threadId, input.branchId)) throw new Error("branch_not_found");
    const record: AgentRunRecord = { ...input, startedAt: input.startedAt ?? this.clock() };
    try {
      await this.database.query(runInsert(record));
    } catch (error) {
      throw normalizeActiveRunConstraint(error);
    }
    return record;
  }

  /** Persist the accepted turn before any Pi context, MCP, or model startup. */
  async createRunWithInitialMessages(input: Parameters<LessonRepository["createRunWithInitialMessages"]>[0]) {
    const { run: record, userMessage, assistantMessage } = input;
    if (!await this.getBranch(record.ownerId, record.threadId, record.branchId)) throw new Error("branch_not_found");
    if (
      (record.userMessageId ?? null) !== (userMessage?.id ?? null)
      || record.assistantMessageId !== assistantMessage.id
      || [...(userMessage ? [userMessage] : []), assistantMessage].some((message) => (
        message.ownerId !== record.ownerId
        || message.threadId !== record.threadId
        || message.branchId !== record.branchId
      ))
      || (userMessage !== undefined && userMessage.role !== "user")
      || assistantMessage.role !== "assistant"
    ) throw new Error("run_initial_messages_scope_invalid");
    try {
      await this.database.batch([
        runInsert(record),
        ...(userMessage ? [messageInsert(userMessage)] : []),
        messageInsert(assistantMessage),
        { sql: "UPDATE agent_threads SET status = 'running', updated_at = ? WHERE owner_id = ? AND id = ?", params: [record.startedAt, record.ownerId, record.threadId] },
      ]);
    } catch (error) {
      throw normalizeActiveRunConstraint(error);
    }
    return { run: record, userMessage, assistantMessage };
  }

  async getRun(ownerId: string, runId: string) { const result = await this.database.query<RunRow>({ sql: `${runSelect} WHERE owner_id = ? AND id = ?`, params: [ownerId, runId] }); return result.rows[0] ? run(result.rows[0]) : null; }
  async getRunByClientCommand(ownerId: string, threadId: string, clientCommandId: string) { const result = await this.database.query<RunRow>({ sql: `${runSelect} WHERE owner_id = ? AND thread_id = ? AND client_command_id = ?`, params: [ownerId, threadId, clientCommandId] }); return result.rows[0] ? run(result.rows[0]) : null; }
  async getLatestRun(ownerId: string, threadId: string, branchId: string) { return this.latestRun(ownerId, threadId, branchId); }
  async getLatestCompletedRun(ownerId: string, threadId: string, branchId: string) { return this.latestRun(ownerId, threadId, branchId, "completed"); }

  async updateRun(ownerId: string, runId: string, patch: Partial<AgentRunRecord>) {
    const columns: Record<string, string> = { status: "status", capabilityPlan: "capability_plan_json", agentDefinitionVersion: "agent_definition_version", skillVersions: "skill_versions_json", attachmentSourceIds: "attachment_source_ids_json", tokenUsage: "token_usage_json", providerCost: "provider_cost", error: "error", leaseToken: "lease_token", leaseExpiresAt: "lease_expires_at", heartbeatAt: "heartbeat_at", cancelRequestedAt: "cancel_requested_at", generationIntentId: "generation_intent_id", userMessageId: "user_message_id", assistantMessageId: "assistant_message_id", completedAt: "completed_at" };
    const json = new Set(["capabilityPlan", "skillVersions", "attachmentSourceIds", "tokenUsage"]);
    const { assignments, params } = updateParts(patch, columns, (key, value) => json.has(key) ? JSON.stringify(value) : value as SqlValue);
    if (!assignments.length) return this.requireRun(ownerId, runId);
    params.push(ownerId, runId);
    const result = await this.database.query({ sql: `UPDATE agent_runs SET ${assignments.join(", ")} WHERE owner_id = ? AND id = ?`, params });
    if (!result.rowsAffected) throw new Error("run_not_found");
    return this.requireRun(ownerId, runId);
  }

  async heartbeatRun(args: Parameters<LessonRepository["heartbeatRun"]>[0]) {
    const now = this.clock();
    const [result] = await this.database.batch([{ sql: `UPDATE agent_runs SET status = 'running', heartbeat_at = ?, lease_expires_at = ?
      WHERE owner_id = ? AND id = ? AND lease_token = ? AND status IN ('queued', 'running') AND lease_expires_at > ?`, params: [now, args.leaseExpiresAt, args.ownerId, args.runId, args.leaseToken, now] },
      { sql: `UPDATE agent_approvals SET continuation_lease_expires_at = ?
        WHERE owner_id = ? AND run_id = ? AND continuation_status = 'running'
          AND continuation_lease_token = ? AND changes() = 1`,
        params: [args.leaseExpiresAt, args.ownerId, args.runId, args.leaseToken] },
    ]);
    if (!result.rowsAffected) throw new Error("run_lease_lost");
    return this.requireRun(args.ownerId, args.runId);
  }

  async settleRun(args: Parameters<LessonRepository["settleRun"]>[0]) {
    const current = await this.requireRun(args.ownerId, args.runId);
    const now = this.clock();
    if (current.cancelRequestedAt && args.status !== "cancelled") {
      throw new Error("run_cancel_requested");
    }
    const runSettled = {
      sql: `UPDATE agent_runs
        SET status = ?, token_usage_json = ?, error = ?,
            completed_at = CASE WHEN ? = 'awaiting_approval' THEN NULL ELSE COALESCE(completed_at, ?) END,
            lease_token = NULL, lease_expires_at = NULL, heartbeat_at = ?
        WHERE owner_id = ? AND id = ? AND (? = 'cancelled' OR cancel_requested_at IS NULL) AND (
          (lease_token = ? AND status IN ('queued', 'running') AND lease_expires_at > ?)
          OR (status = ? AND lease_token IS NULL)
        )`,
      params: [
        args.status, JSON.stringify(args.tokenUsage ?? current.tokenUsage ?? {}), args.error ?? current.error ?? null,
        args.status, now, now, args.ownerId, args.runId, args.status, args.leaseToken, now, args.status,
      ],
    } satisfies SqlStatement;
    const statements: SqlStatement[] = [runSettled];
    if (current.assistantMessageId && args.messageStatus) {
      statements.push(messageSettlementStatement({
        ownerId: args.ownerId,
        runId: args.runId,
        assistantMessageId: current.assistantMessageId,
        runStatus: args.status,
        messageStatus: args.messageStatus,
        error: args.error,
        content: args.messageContent,
        sources: args.messageSources,
        sessionCursor: args.sessionCursor,
      }));
    }
    statements.push({
      sql: `UPDATE agent_threads
        SET status = CASE
          WHEN EXISTS (
            SELECT 1 FROM agent_runs
            WHERE owner_id = ? AND thread_id = ? AND status = 'awaiting_approval'
          ) THEN 'awaiting_approval'
          WHEN EXISTS (
            SELECT 1 FROM agent_runs
            WHERE owner_id = ? AND thread_id = ? AND status IN ('queued', 'running')
          ) THEN 'running'
          ELSE 'idle'
        END,
        updated_at = ?
        WHERE owner_id = ? AND id = ?
          AND EXISTS (
            SELECT 1 FROM agent_runs
            WHERE owner_id = ? AND id = ? AND status = ? AND lease_token IS NULL
          )`,
      params: [
        args.ownerId, current.threadId, args.ownerId, current.threadId, now,
        args.ownerId, current.threadId, args.ownerId, args.runId, args.status,
      ],
    });
    const results = await this.database.batch(statements);
    if (!results[0]?.rowsAffected) {
      const latest = await this.requireRun(args.ownerId, args.runId);
      if (latest.cancelRequestedAt && args.status !== "cancelled") throw new Error("run_cancel_requested");
      throw new Error("run_lease_lost");
    }
    return this.requireRun(args.ownerId, args.runId);
  }

  async requestRunCancellation(ownerId: string, runId: string) {
    const current = await this.requireRun(ownerId, runId);
    if (current.status === "cancelled") return true;
    if (current.status !== "queued" && current.status !== "running") return false;
    const now = this.clock();
    const result = await this.database.query({ sql: "UPDATE agent_runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE owner_id = ? AND id = ? AND status IN ('queued', 'running')", params: [now, ownerId, runId] });
    if (!result.rowsAffected) return false;
    return true;
  }

  async recoverExpiredRuns(ownerId: string, threadId?: string) {
    const now = this.clock();
    const clauses = [
      "owner_id = ?",
      "status IN ('queued', 'running')",
      "((lease_expires_at IS NOT NULL AND lease_expires_at <= ?) OR (lease_expires_at IS NULL AND COALESCE(heartbeat_at, started_at) <= ?))",
    ];
    const params: SqlValue[] = [ownerId, now, new Date(Date.parse(now) - 120_000).toISOString()];
    if (threadId) {
      clauses.push("thread_id = ?");
      params.push(threadId);
    }
    const stale = await this.database.query<RunRow>({ sql: `${runSelect} WHERE ${clauses.join(" AND ")}`, params });
    for (const row of stale.rows.map(run)) {
      const statements: SqlStatement[] = [{
        sql: `UPDATE agent_runs SET
          status = CASE
            WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
            WHEN EXISTS (
              SELECT 1 FROM agent_approvals
              WHERE owner_id = ? AND run_id = ? AND state = 'pending'
            ) THEN 'awaiting_approval'
            ELSE 'failed'
          END,
          error = CASE
            WHEN cancel_requested_at IS NOT NULL THEN NULL
            WHEN EXISTS (
              SELECT 1 FROM agent_approvals
              WHERE owner_id = ? AND run_id = ? AND state = 'pending'
            ) THEN NULL
            ELSE 'run_interrupted'
          END,
          completed_at = CASE
            WHEN cancel_requested_at IS NULL AND EXISTS (
              SELECT 1 FROM agent_approvals
              WHERE owner_id = ? AND run_id = ? AND state = 'pending'
            ) THEN NULL
            ELSE ?
          END,
          lease_token = NULL, lease_expires_at = NULL, heartbeat_at = ?
          WHERE owner_id = ? AND id = ? AND status IN ('queued', 'running')
            AND ((lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
              OR (lease_expires_at IS NULL AND COALESCE(heartbeat_at, started_at) <= ?))`,
        params: [
          ownerId, row.id,
          ownerId, row.id,
          ownerId, row.id,
          now, now, ownerId, row.id, now,
          new Date(Date.parse(now) - 120_000).toISOString(),
        ],
      }];
      if (row.assistantMessageId) {
        statements.push({
          sql: `UPDATE agent_messages SET
            status = CASE (
              SELECT status FROM agent_runs WHERE owner_id = ? AND id = ?
            )
              WHEN 'awaiting_approval' THEN 'completed'
              WHEN 'cancelled' THEN 'cancelled'
              ELSE 'failed'
            END,
            error = CASE WHEN (
              SELECT status FROM agent_runs WHERE owner_id = ? AND id = ?
            ) = 'failed' THEN 'run_interrupted' ELSE NULL END
            WHERE owner_id = ? AND id = ?
              AND EXISTS (
                SELECT 1 FROM agent_runs
                WHERE owner_id = ? AND id = ?
                  AND status IN ('awaiting_approval', 'cancelled', 'failed')
                  AND lease_token IS NULL
              )`,
          params: [
            ownerId, row.id, ownerId, row.id,
            ownerId, row.assistantMessageId,
            ownerId, row.id,
          ],
        });
      }
      statements.push({
        sql: `UPDATE agent_threads
          SET status = CASE
            WHEN EXISTS (
              SELECT 1 FROM agent_runs
              WHERE owner_id = ? AND thread_id = ? AND status = 'awaiting_approval'
            ) THEN 'awaiting_approval'
            WHEN EXISTS (
              SELECT 1 FROM agent_runs
              WHERE owner_id = ? AND thread_id = ? AND status IN ('queued', 'running')
            ) THEN 'running'
            ELSE 'idle'
          END,
          updated_at = ?
          WHERE owner_id = ? AND id = ?
            AND EXISTS (
              SELECT 1 FROM agent_runs
              WHERE owner_id = ? AND id = ?
                AND status IN ('awaiting_approval', 'cancelled', 'failed')
                AND lease_token IS NULL
            )`,
        params: [
          ownerId, row.threadId, ownerId, row.threadId, now,
          ownerId, row.threadId,
          ownerId, row.id,
        ],
      });
      statements.push({ sql: `UPDATE agent_messages SET
          status = (SELECT status FROM agent_runs WHERE owner_id = ? AND id = ?)
        WHERE owner_id = ? AND id IN (SELECT continuation_message_id FROM agent_approvals
          WHERE owner_id = ? AND run_id = ? AND continuation_status = 'running' AND continuation_lease_token = ?)
          AND EXISTS (SELECT 1 FROM agent_runs WHERE owner_id = ? AND id = ?
            AND status IN ('failed', 'cancelled') AND lease_token IS NULL)`,
        params: [ownerId, row.id, ownerId, ownerId, row.id, row.leaseToken ?? null, ownerId, row.id] },
      { sql: `UPDATE agent_approvals SET continuation_status = CASE
          WHEN EXISTS (SELECT 1 FROM agent_runs WHERE owner_id = ? AND id = ? AND status = 'cancelled') THEN 'completed' ELSE 'ready' END,
          continuation_lease_token = NULL, continuation_lease_expires_at = NULL
        WHERE owner_id = ? AND run_id = ? AND continuation_status = 'running' AND continuation_lease_token = ?
          AND EXISTS (SELECT 1 FROM agent_runs WHERE owner_id = ? AND id = ?
            AND status IN ('failed', 'cancelled') AND lease_token IS NULL)`,
        params: [ownerId, row.id, ownerId, row.id, row.leaseToken ?? null, ownerId, row.id] });
      await this.database.batch(statements);
    }
    return stale.rows.length;
  }

  async appendRunEvent(ownerId: string, runId: string, type: string, data: unknown) {
    const result = await this.database.query({
      sql: `INSERT INTO agent_events (id, owner_id, run_id, event_type, data_json, created_at, sequence_no)
        SELECT ?, ?, ?, ?, ?, ?, COALESCE((
          SELECT MAX(sequence_no) FROM agent_events WHERE owner_id = ? AND run_id = ?
        ), 0) + 1
        FROM agent_runs
        WHERE owner_id = ? AND id = ?`,
      params: [
        crypto.randomUUID(), ownerId, runId, type, JSON.stringify(data), this.clock(),
        ownerId, runId, ownerId, runId,
      ],
    });
    if (!result.rowsAffected) throw new Error("run_not_found");
  }
  async listRunEvents(ownerId: string, runId: string) { const result = await this.database.query<{ data_json: string }>({ sql: "SELECT data_json FROM agent_events WHERE owner_id = ? AND run_id = ? ORDER BY sequence_no", params: [ownerId, runId] }); return result.rows.map((row) => JSON.parse(row.data_json) as NormalizedAgentEvent); }

  async getSessionItems(ownerId: string, threadId: string, branchId: string, limit?: number) { return this.sessionItems(ownerId, threadId, branchId, 0, limit); }
  async getSessionItemsAfter(ownerId: string, threadId: string, branchId: string, afterCursor: number, limit?: number) { return this.sessionItems(ownerId, threadId, branchId, afterCursor, limit); }
  async getSessionItemCount(ownerId: string, threadId: string, branchId: string) { const result = await this.database.query<{ total: number }>({ sql: "SELECT COUNT(*) AS total FROM agent_session_items WHERE owner_id = ? AND thread_id = ? AND branch_id = ?", params: [ownerId, threadId, branchId] }); return Number(result.rows[0]?.total ?? 0); }
  async addSessionItems(ownerId: string, threadId: string, branchId: string, items: AgentSessionItem[], idempotencyKey?: string) {
    if (!items.length) return; if (!await this.getBranch(ownerId, threadId, branchId)) throw new Error("branch_not_found");
    const payload = JSON.stringify(items);
    if (idempotencyKey) {
      const existing = await this.database.query<{ payload_json: string }>({ sql: "SELECT payload_json FROM agent_session_append_batches WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND idempotency_key = ?", params: [ownerId, threadId, branchId, idempotencyKey] });
      if (existing.rows[0]) {
        if (existing.rows[0].payload_json !== payload) throw new Error("idempotency_conflict");
        return;
      }
    }
    const count = await this.getSessionItemCount(ownerId, threadId, branchId); const timestamp = this.clock();
    const statements: SqlStatement[] = items.map((item, index) => ({ sql: "INSERT INTO agent_session_items (id, owner_id, thread_id, branch_id, sequence_no, item_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [crypto.randomUUID(), ownerId, threadId, branchId, count + index + 1, JSON.stringify(item), timestamp] }));
    if (idempotencyKey) statements.push({ sql: "INSERT INTO agent_session_append_batches (owner_id, thread_id, branch_id, idempotency_key, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", params: [ownerId, threadId, branchId, idempotencyKey, payload, timestamp] });
    await this.database.batch(statements);
  }
  async replaceSessionItems(ownerId: string, threadId: string, branchId: string, items: AgentSessionItem[]) {
    if (!await this.getBranch(ownerId, threadId, branchId)) throw new Error("branch_not_found");
    const timestamp = this.clock();
    await this.database.batch([
      { sql: "DELETE FROM agent_session_items WHERE owner_id = ? AND thread_id = ? AND branch_id = ?", params: [ownerId, threadId, branchId] },
      { sql: "DELETE FROM agent_session_append_batches WHERE owner_id = ? AND thread_id = ? AND branch_id = ?", params: [ownerId, threadId, branchId] },
      { sql: "DELETE FROM agent_thread_memories WHERE owner_id = ? AND thread_id = ? AND branch_id = ?", params: [ownerId, threadId, branchId] },
      ...items.map((item, index) => ({ sql: "INSERT INTO agent_session_items (id, owner_id, thread_id, branch_id, sequence_no, item_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [crypto.randomUUID(), ownerId, threadId, branchId, index + 1, JSON.stringify(item), timestamp] })),
    ]);
  }
  async popSessionItem(ownerId: string, threadId: string, branchId: string) { const result = await this.database.query<{ id: string; item_json: string }>({ sql: "SELECT id, item_json FROM agent_session_items WHERE owner_id = ? AND thread_id = ? AND branch_id = ? ORDER BY sequence_no DESC LIMIT 1", params: [ownerId, threadId, branchId] }); const item = result.rows[0]; if (!item) return undefined; const deleted = await this.database.query({ sql: "DELETE FROM agent_session_items WHERE id = ? AND owner_id = ? AND thread_id = ? AND branch_id = ?", params: [item.id, ownerId, threadId, branchId] }); return deleted.rowsAffected ? JSON.parse(item.item_json) as AgentSessionItem : undefined; }
  async clearSession(ownerId: string, threadId: string, branchId: string) { await this.database.batch([{ sql: "DELETE FROM agent_session_items WHERE owner_id = ? AND thread_id = ? AND branch_id = ?", params: [ownerId, threadId, branchId] }, { sql: "DELETE FROM agent_session_append_batches WHERE owner_id = ? AND thread_id = ? AND branch_id = ?", params: [ownerId, threadId, branchId] }]); }

  async getAgentRuntimeSession(ownerId: string, threadId: string, branchId: string, runtime: AgentRuntimeName) {
    const [header, rows] = await this.database.batch([
      {
        sql: "SELECT owner_id, thread_id, branch_id, runtime, revision, messages_json, updated_at FROM agent_runtime_sessions WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND runtime = ?",
        params: [ownerId, threadId, branchId, runtime],
      },
      {
        sql: "SELECT message_json FROM agent_runtime_session_messages WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND runtime = ? ORDER BY sequence_no",
        params: [ownerId, threadId, branchId, runtime],
      },
    ]);
    if (!header.rows[0]) return null;
    const messages = rows.rows.length
      ? rows.rows.map((row) => JSON.parse(String(row.message_json)) as unknown)
      : json<unknown[]>(header.rows[0].messages_json, []);
    return runtimeSession(header.rows[0], messages);
  }

  async saveAgentRuntimeSession(args: Parameters<LessonRepository["saveAgentRuntimeSession"]>[0]) {
    if (!await this.getBranch(args.ownerId, args.threadId, args.branchId)) throw new Error("agent_runtime_session_scope_invalid");
    const timestamp = this.clock();
    const incoming = args.messages;
    const header = await this.database.query<Record<string, unknown>>({
      sql: "SELECT revision FROM agent_runtime_sessions WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND runtime = ?",
      params: [args.ownerId, args.threadId, args.branchId, args.runtime],
    });
    if (!header.rows[0]) {
      if (args.expectedRevision !== 0) throw new Error("agent_runtime_session_conflict");
      await this.database.batch([
        {
          sql: "INSERT INTO agent_runtime_sessions (owner_id, thread_id, branch_id, runtime, revision, messages_json, updated_at) VALUES (?, ?, ?, ?, 1, '[]', ?)",
          params: [args.ownerId, args.threadId, args.branchId, args.runtime, timestamp],
        },
        ...incoming.map((message, index) => runtimeSessionMessageInsert(args, index + 1, message, timestamp)),
      ]);
      return runtimeSnapshot(args, 1, incoming, timestamp);
    }
    const currentRevision = Number(header.rows[0].revision);
    if (currentRevision !== args.expectedRevision) throw new Error("agent_runtime_session_conflict");
    const counted = await this.database.query<{ total: number }>({
      sql: "SELECT COUNT(*) AS total FROM agent_runtime_session_messages WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND runtime = ?",
      params: [args.ownerId, args.threadId, args.branchId, args.runtime],
    });
    const storedCount = Number(counted.rows[0]?.total ?? 0);
    const plan = runtimeSessionWritePlan(storedCount, incoming.length, args.rewriteFrom);
    const statements: SqlStatement[] = [];
    if (plan.deleteAfter !== null) {
      statements.push({
        sql: "DELETE FROM agent_runtime_session_messages WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND runtime = ? AND sequence_no > ? AND EXISTS (SELECT 1 FROM agent_runtime_sessions WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND runtime = ? AND revision = ?)",
        params: [
          args.ownerId, args.threadId, args.branchId, args.runtime, plan.deleteAfter,
          args.ownerId, args.threadId, args.branchId, args.runtime, args.expectedRevision,
        ],
      });
    }
    for (const [offset, message] of incoming.slice(plan.appendFrom).entries()) {
      statements.push(runtimeSessionMessageCasInsert(args, plan.appendFrom + offset + 1, message, timestamp));
    }
    statements.push({
      sql: "UPDATE agent_runtime_sessions SET revision = revision + 1, messages_json = '[]', updated_at = ? WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND runtime = ? AND revision = ?",
      params: [timestamp, args.ownerId, args.threadId, args.branchId, args.runtime, args.expectedRevision],
    });
    const results = await this.database.batch(statements);
    if (!results.at(-1)?.rowsAffected) throw new Error("agent_runtime_session_conflict");
    return runtimeSnapshot(args, currentRevision + 1, incoming, timestamp);
  }
  async getThreadMemory(ownerId: string, threadId: string, branchId: string) { const result = await this.database.query<{ summary: string; summary_cursor: number }>({ sql: "SELECT summary, summary_cursor FROM agent_thread_memories WHERE owner_id = ? AND thread_id = ? AND branch_id = ?", params: [ownerId, threadId, branchId] }); return result.rows[0] ? { summary: result.rows[0].summary, cursor: Number(result.rows[0].summary_cursor) } : null; }
  async saveThreadMemory(ownerId: string, threadId: string, branchId: string, summary: string, cursor: number) { await this.database.query({ sql: "INSERT INTO agent_thread_memories (owner_id, thread_id, branch_id, summary, summary_cursor, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, thread_id, branch_id) DO UPDATE SET summary = excluded.summary, summary_cursor = excluded.summary_cursor, updated_at = excluded.updated_at", params: [ownerId, threadId, branchId, summary, cursor, this.clock()] }); }

  private async latestRun(ownerId: string, threadId: string, branchId: string, status?: "completed") { const result = await this.database.query<RunRow>({ sql: `${runSelect} WHERE owner_id = ? AND thread_id = ? AND branch_id = ?${status ? " AND status = 'completed'" : ""} ORDER BY started_at DESC, id DESC LIMIT 1`, params: [ownerId, threadId, branchId] }); return result.rows[0] ? run(result.rows[0]) : null; }
  private async requireBranch(ownerId: string, threadId: string, branchId: string) { const value = await this.getBranch(ownerId, threadId, branchId); if (!value) throw new Error("branch_not_found"); return value; }
  private async requireMessage(ownerId: string, messageId: string) { const value = await this.getMessage(ownerId, messageId); if (!value) throw new Error("message_not_found"); return value; }
  private async requireRun(ownerId: string, runId: string) { const value = await this.getRun(ownerId, runId); if (!value) throw new Error("run_not_found"); return value; }
  private async sessionItems(ownerId: string, threadId: string, branchId: string, after: number, limit?: number) { const direction = limit ? "DESC" : "ASC"; const result = await this.database.query<{ item_json: string }>({ sql: `SELECT item_json FROM agent_session_items WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND sequence_no > ? ORDER BY sequence_no ${direction}${limit ? " LIMIT ?" : ""}`, params: limit ? [ownerId, threadId, branchId, after, limit] : [ownerId, threadId, branchId, after] }); const rows = limit ? result.rows.reverse() : result.rows; return rows.map((row) => JSON.parse(row.item_json) as AgentSessionItem); }
  private async withRunPresentation(ownerId: string, messages: AgentMessageRecord[]) { const assistants = messages.filter((item) => item.role === "assistant"); if (!assistants.length) return messages; const result = await this.database.query<RunRow>({ sql: `${runSelect} WHERE owner_id = ? AND assistant_message_id IN (${assistants.map(() => "?").join(",")}) ORDER BY started_at DESC, id DESC`, params: [ownerId, ...assistants.map((item) => item.id)] }); const byMessage = new Map<string, AgentRunRecord>(); for (const value of result.rows.map(run)) if (value.assistantMessageId && !byMessage.has(value.assistantMessageId)) byMessage.set(value.assistantMessageId, value); return Promise.all(messages.map(async (item) => { const value = byMessage.get(item.id); if (!value) return item; const events = await this.listRunEvents(ownerId, value.id); return { ...item, activities: persistedActivitiesFromEvents(events, value.status), turnTexts: persistedTurnTextsFromEvents(events), turn: { runId: value.id, status: value.status, ...persistedTurnPhaseFromEvents(events, value.status), startedAt: value.startedAt, completedAt: value.completedAt } }; })); }
  private async copyForkHistory(ownerId: string, threadId: string, sourceId: string, targetId: string, forkedFromMessageId?: string, forkCursor?: number) {
    const messages = await this.listMessages(ownerId, threadId, sourceId, undefined, 10_000); const index = forkedFromMessageId ? messages.findIndex((value) => value.id === forkedFromMessageId) : messages.length - 1;
    const inherited = messages.slice(0, index + 1); if (inherited.length) await this.database.batch(inherited.map((value) => ({ sql: "INSERT INTO agent_messages (id, owner_id, thread_id, branch_id, role, content, status, error, sources_json, session_cursor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params: [crypto.randomUUID(), ownerId, threadId, targetId, value.role, value.content, value.status, value.error ?? null, JSON.stringify(value.sources ?? []), value.sessionCursor ?? null, value.createdAt] })));
    const items = forkCursor === undefined ? inherited.map((value) => ({ type: "message", role: value.role, content: value.content })) : await this.getSessionItemsAfter(ownerId, threadId, sourceId, 0, forkCursor); await this.addSessionItems(ownerId, threadId, targetId, items);
  }

  private async copyPiRuntimeSession(
    ownerId: string,
    threadId: string,
    sourceId: string,
    targetId: string,
    forkCursor?: number,
  ) {
    const parent = await this.getAgentRuntimeSession(ownerId, threadId, sourceId, "pi");
    if (!parent) return;
    if (forkCursor !== undefined && parent.messages.length < forkCursor) throw new Error("fork_session_not_committed");
    const messages = forkCursor === undefined ? parent.messages : parent.messages.slice(0, forkCursor);
    if (!messages.length) return;
    await this.saveAgentRuntimeSession({
      ownerId,
      threadId,
      branchId: targetId,
      runtime: "pi",
      expectedRevision: 0,
      messages,
    });
  }
  private async replay<T>(ownerId: string, operation: string, key: string, fingerprint: string) { const result = await this.database.query<{ request_fingerprint: string; response_json: string }>({ sql: "SELECT request_fingerprint, response_json FROM operation_idempotency WHERE owner_id = ? AND operation = ? AND idempotency_key = ?", params: [ownerId, operation, key] }); const row = result.rows[0]; if (!row) return null; if (row.request_fingerprint !== fingerprint) throw new Error("idempotency_conflict"); return JSON.parse(row.response_json) as T; }
  private storeReplay(ownerId: string, operation: string, key: string, fingerprint: string, response: unknown, timestamp: string): SqlStatement[] { return [{ sql: "INSERT INTO operation_idempotency (owner_id, operation, idempotency_key, request_fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", params: [ownerId, operation, key, fingerprint, JSON.stringify(response), timestamp] }]; }
}

const threadSelect = "SELECT id, owner_id, notebook_id, resource_type, lesson_file_id, semester_framework_id, title, status, starter_suggestions_json, starter_suggestions_document_version, starter_suggestions_resource_version, archived_at, deleted_at, created_at, updated_at FROM agent_threads";
const branchSelect = "SELECT id, owner_id, thread_id, parent_branch_id, forked_from_message_id, label, pending_interaction_json, created_at FROM agent_branches";
const messageSelect = "SELECT id, owner_id, thread_id, branch_id, role, content, status, error, sources_json, session_cursor, created_at FROM agent_messages";
const runSelect = "SELECT id, owner_id, thread_id, branch_id, generation_intent_id, client_command_id, command_fingerprint, user_message_id, assistant_message_id, model, status, capability_plan_json, agent_definition_version, skill_versions_json, attachment_source_ids_json, token_usage_json, provider_cost, error, lease_token, lease_expires_at, heartbeat_at, cancel_requested_at, started_at, completed_at FROM agent_runs";
const approvalSelectForSnapshot = `SELECT id, owner_id, run_id, thread_id, branch_id, assistant_message_id, tool_call_id, state,
  patch_json, encrypted_run_state, agent_definition_version, resource_type, patch_kind,
  lesson_file_id, semester_framework_id, base_resource_version, document_version,
  continuation_status, continuation_lease_token, continuation_lease_expires_at,
  continuation_attempt_count, continuation_error, continuation_message_id, expires_at, created_at
  FROM agent_approvals`;
const json = <T>(value: unknown, fallback: T): T => { try { return value ? JSON.parse(String(value)) as T : fallback; } catch { return fallback; } };
const numberOrUndefined = (value: unknown) => value == null ? undefined : Number(value);
const thread = (row: ThreadRow): AgentThreadRecord => {
  const common = {
    id: String(row.id), ownerId: String(row.owner_id), notebookId: String(row.notebook_id),
    title: String(row.title), status: row.status as AgentThreadRecord["status"],
    starterSuggestions: json<string[]>(row.starter_suggestions_json, []),
    starterSuggestionsDocumentVersion: numberOrUndefined(row.starter_suggestions_document_version),
    starterSuggestionsResourceVersion: numberOrUndefined(row.starter_suggestions_resource_version),
    archivedAt: row.archived_at ? String(row.archived_at) : undefined,
    deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
  return row.resource_type === "semester_framework"
    ? { ...common, resourceType: "semester_framework", semesterFrameworkId: String(row.semester_framework_id) }
    : { ...common, resourceType: "lesson_file", lessonFileId: String(row.lesson_file_id) };
};
const branch = (row: BranchRow): AgentBranchRecord => ({ id: String(row.id), ownerId: String(row.owner_id), threadId: String(row.thread_id), parentBranchId: row.parent_branch_id ? String(row.parent_branch_id) : undefined, forkedFromMessageId: row.forked_from_message_id ? String(row.forked_from_message_id) : undefined, label: String(row.label), pendingInteraction: row.pending_interaction_json ? json(row.pending_interaction_json, null) : null, createdAt: String(row.created_at) });
const message = (row: MessageRow): AgentMessageRecord => ({ id: String(row.id), ownerId: String(row.owner_id), threadId: String(row.thread_id), branchId: String(row.branch_id), role: row.role as AgentMessageRecord["role"], content: String(row.content), status: row.status as AgentMessageRecord["status"], error: row.error ? String(row.error) : undefined, sources: json<SourceRef[]>(row.sources_json, []), sessionCursor: numberOrUndefined(row.session_cursor), createdAt: String(row.created_at) });
const run = (row: RunRow): AgentRunRecord => ({ id: String(row.id), ownerId: String(row.owner_id), threadId: String(row.thread_id), branchId: String(row.branch_id), model: String(row.model), status: row.status as AgentRunRecord["status"], capabilityPlan: json(row.capability_plan_json, undefined), agentDefinitionVersion: row.agent_definition_version ? String(row.agent_definition_version) : undefined, skillVersions: json(row.skill_versions_json, undefined), attachmentSourceIds: json(row.attachment_source_ids_json, undefined), tokenUsage: json(row.token_usage_json, undefined), providerCost: numberOrUndefined(row.provider_cost), error: row.error ? String(row.error) : undefined, leaseToken: row.lease_token ? String(row.lease_token) : undefined, leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined, heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : undefined, cancelRequestedAt: row.cancel_requested_at ? String(row.cancel_requested_at) : undefined, generationIntentId: row.generation_intent_id ? String(row.generation_intent_id) : undefined, clientCommandId: row.client_command_id ? String(row.client_command_id) : undefined, commandFingerprint: row.command_fingerprint ? String(row.command_fingerprint) : undefined, userMessageId: row.user_message_id ? String(row.user_message_id) : undefined, assistantMessageId: row.assistant_message_id ? String(row.assistant_message_id) : undefined, startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : undefined });
const approvalFromSnapshot = (row: Record<string, unknown>) => ({
  id: String(row.id), ownerId: String(row.owner_id), runId: String(row.run_id),
  threadId: String(row.thread_id), branchId: String(row.branch_id),
  assistantMessageId: row.assistant_message_id ? String(row.assistant_message_id) : undefined,
  toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined,
  state: row.state as AgentApprovalRecord["state"],
  patch: json<ResourcePatch>(row.patch_json, {} as ResourcePatch),
  encryptedRunState: String(row.encrypted_run_state),
  agentDefinitionVersion: String(row.agent_definition_version),
  resourceType: row.resource_type as AgentApprovalRecord["resourceType"],
  patchKind: row.patch_kind as AgentApprovalRecord["patchKind"],
  lessonFileId: row.lesson_file_id ? String(row.lesson_file_id) : undefined,
  semesterFrameworkId: row.semester_framework_id ? String(row.semester_framework_id) : undefined,
  baseResourceVersion: numberOrUndefined(row.base_resource_version),
  documentVersion: numberOrUndefined(row.document_version),
  continuationStatus: row.continuation_status as AgentApprovalRecord["continuationStatus"],
  continuationLeaseToken: row.continuation_lease_token ? String(row.continuation_lease_token) : undefined,
  continuationLeaseExpiresAt: row.continuation_lease_expires_at ? String(row.continuation_lease_expires_at) : undefined,
  continuationAttemptCount: numberOrUndefined(row.continuation_attempt_count),
  continuationError: row.continuation_error ? String(row.continuation_error) : undefined,
  continuationMessageId: row.continuation_message_id ? String(row.continuation_message_id) : undefined,
  expiresAt: String(row.expires_at), createdAt: String(row.created_at),
} satisfies AgentApprovalRecord);
const runtimeSession = (row: Record<string, unknown>, messages: unknown[]): AgentRuntimeSessionSnapshot => ({
  ownerId: String(row.owner_id),
  threadId: String(row.thread_id),
  branchId: String(row.branch_id),
  runtime: row.runtime as AgentRuntimeName,
  revision: Number(row.revision),
  messages,
  updatedAt: String(row.updated_at),
});
const runtimeSnapshot = (
  args: { ownerId: string; threadId: string; branchId: string; runtime: AgentRuntimeName },
  revision: number,
  messages: unknown[],
  updatedAt: string,
): AgentRuntimeSessionSnapshot => ({
  ownerId: args.ownerId,
  threadId: args.threadId,
  branchId: args.branchId,
  runtime: args.runtime,
  revision,
  messages,
  updatedAt,
});
const runtimeSessionScope = (args: { ownerId: string; threadId: string; branchId: string; runtime: AgentRuntimeName }) => [
  args.ownerId, args.threadId, args.branchId, args.runtime,
] as const;
const runtimeSessionMessageInsert = (
  args: { ownerId: string; threadId: string; branchId: string; runtime: AgentRuntimeName },
  sequenceNo: number,
  message: unknown,
  timestamp: string,
): SqlStatement => ({
  sql: "INSERT INTO agent_runtime_session_messages (owner_id, thread_id, branch_id, runtime, sequence_no, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  params: [...runtimeSessionScope(args), sequenceNo, JSON.stringify(message), timestamp],
});
const runtimeSessionMessageCasInsert = (
  args: { ownerId: string; threadId: string; branchId: string; runtime: AgentRuntimeName; expectedRevision: number },
  sequenceNo: number,
  message: unknown,
  timestamp: string,
): SqlStatement => ({
  sql: "INSERT INTO agent_runtime_session_messages (owner_id, thread_id, branch_id, runtime, sequence_no, message_json, created_at) SELECT ?, ?, ?, ?, ?, ?, ? FROM agent_runtime_sessions WHERE owner_id = ? AND thread_id = ? AND branch_id = ? AND runtime = ? AND revision = ?",
  params: [
    ...runtimeSessionScope(args), sequenceNo, JSON.stringify(message), timestamp,
    ...runtimeSessionScope(args), args.expectedRevision,
  ],
});
const updateParts = (patch: Record<string, unknown>, columns: Record<string, string>, transform: (key: string, value: unknown) => SqlValue) => { const assignments: string[] = []; const params: SqlValue[] = []; for (const [key, value] of Object.entries(patch)) if (value !== undefined && columns[key]) { assignments.push(`${columns[key]} = ?`); params.push(transform(key, value)); } return { assignments, params }; };
const messageCursor = (cursor?: string) => { if (!cursor) return { clause: "", params: [] as SqlValue[] }; const separator = cursor.lastIndexOf("|"); if (separator > 0) { const timestamp = cursor.slice(0, separator); const id = cursor.slice(separator + 1); return { clause: "AND (created_at < ? OR (created_at = ? AND id < ?))", params: [timestamp, timestamp, id] }; } return { clause: "AND created_at < ?", params: [cursor] }; };
const runInsert = (value: AgentRunRecord): SqlStatement => ({
  sql: `INSERT INTO agent_runs (id, owner_id, thread_id, branch_id, generation_intent_id, client_command_id, command_fingerprint, user_message_id, assistant_message_id, model, status, capability_plan_json, agent_definition_version, skill_versions_json, attachment_source_ids_json, token_usage_json, provider_cost, error, lease_token, lease_expires_at, heartbeat_at, cancel_requested_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  params: runParams(value),
});
const messageInsert = (value: AgentMessageRecord): SqlStatement => ({
  sql: `INSERT INTO agent_messages (id, owner_id, thread_id, branch_id, role, content, status, error, sources_json, session_cursor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  params: [value.id, value.ownerId, value.threadId, value.branchId, value.role, value.content, value.status, value.error ?? null, JSON.stringify(value.sources ?? []), value.sessionCursor ?? null, value.createdAt],
});
const runParams = (value: AgentRunRecord): SqlValue[] => [value.id, value.ownerId, value.threadId, value.branchId, value.generationIntentId ?? null, value.clientCommandId ?? null, value.commandFingerprint ?? null, value.userMessageId ?? null, value.assistantMessageId ?? null, value.model, value.status, value.capabilityPlan ? JSON.stringify(value.capabilityPlan) : null, value.agentDefinitionVersion ?? null, JSON.stringify(value.skillVersions ?? {}), JSON.stringify(value.attachmentSourceIds ?? []), JSON.stringify(value.tokenUsage ?? {}), value.providerCost ?? null, value.error ?? null, value.leaseToken ?? null, value.leaseExpiresAt ?? null, value.heartbeatAt ?? null, value.cancelRequestedAt ?? null, value.startedAt, value.completedAt ?? null];

function messageSettlementStatement(args: {
  ownerId: string;
  runId: string;
  assistantMessageId: string;
  runStatus: AgentRunRecord["status"];
  messageStatus: AgentMessageRecord["status"];
  error?: string;
  content?: string;
  sources?: SourceRef[];
  sessionCursor?: number;
}): SqlStatement {
  const assignments = ["status = ?", "error = ?"];
  const params: SqlValue[] = [args.messageStatus, args.error ?? null];
  if (args.content !== undefined) {
    assignments.push("content = ?");
    params.push(args.content);
  }
  if (args.sources !== undefined) {
    assignments.push("sources_json = ?");
    params.push(JSON.stringify(args.sources));
  }
  if (args.sessionCursor !== undefined) {
    assignments.push("session_cursor = ?");
    params.push(args.sessionCursor);
  }
  params.push(
    args.ownerId, args.assistantMessageId,
    args.ownerId, args.runId, args.runStatus,
  );
  return {
    sql: `UPDATE agent_messages SET ${assignments.join(", ")}
      WHERE owner_id = ? AND id = ?
        AND EXISTS (
          SELECT 1 FROM agent_runs
          WHERE owner_id = ? AND id = ? AND status = ? AND lease_token IS NULL
        )`,
    params,
  };
}

function normalizeActiveRunConstraint(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("agent_runs_one_active_thread")
    || /UNIQUE constraint failed:\s*agent_runs\.owner_id,\s*agent_runs\.thread_id/i.test(message)
  ) {
    return new Error("active_run_exists");
  }
  return error;
}
