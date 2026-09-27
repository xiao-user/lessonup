import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { agentApi, consumeAgentStream } from "@/lib/agent-api";
import { persistThinkingLevel, readStoredThinkingLevel } from "@/lib/thinking-level.js";
import {
  activeApprovalFrom,
  activitiesFromEvents,
  activityStateForToolCompletion,
  agentInputDisposition,
  approvalBackedToolCallIds,
  lastRetryableUserMessage,
  resetAgentConversationState,
  queuedInputsFromEvents,
  resolveBranchSourceMessage,
  stopAgentRun,
  synchronizeCompletedAgentTurn,
} from "./agent-run-control.js";
import {
  hasBlockingUploads,
  readyUploadSources,
} from "./attachment-state.js";
import {
  isAgentEventActive,
  resolveAgentEventScope,
} from "./agent-event-scope.js";
import { dedupeAgentSources, latestAssistantSources } from "./source-state.js";
import { approvalPhase } from "./approval-state.js";
import { executeApprovalCommand } from "./approval-command.js";
import {
  conversationStateReducer,
  initialConversationState,
  shouldRecoverConversation,
} from "./conversation-state.js";

const draftKey = (threadId) => `lessonup:agent-draft:${threadId ?? "new"}`;

const branchKey = (threadId) => `lessonup:agent-branch:${threadId}`;

function updateActiveAssistantTurn(messages, runId, patch) {
  const index = messages.findLastIndex((message) => (
    message.role === "assistant"
    && message.status === "streaming"
    && (!message.turn?.runId || message.turn.runId === runId)
  ));
  if (index < 0) return messages;
  const next = [...messages];
  next[index] = {
    ...next[index],
    turn: { ...next[index].turn, runId, ...patch },
  };
  return next;
}

export function useAgentChat({
  notebookId,
  lessonFileId,
  semesterFrameworkId,
  documentVersion,
  frameworkVersion,
  activeSectionId,
  activeUnitId,
  selection,
  onCanonicalDocument,
  onCanonicalFramework,
  onBeforeRun,
  starterSuggestionsEnabled = true,
}) {
  const resourceType = semesterFrameworkId ? "semester_framework" : "lesson_file";
  const resourceId = semesterFrameworkId ?? lessonFileId;
  const resourceVersion = resourceType === "semester_framework"
    ? frameworkVersion
    : documentVersion;
  const resourceScope = useMemo(() => (
    resourceType === "semester_framework"
      ? { semesterFrameworkId: resourceId }
      : { lessonFileId: resourceId }
  ), [resourceId, resourceType]);
  const [runtime, setRuntime] = useState(null);
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [branches, setBranches] = useState([]);
  const [activeBranchId, setActiveBranchId] = useState(null);
  const [conversation, dispatchConversation] = useReducer(
    conversationStateReducer,
    initialConversationState,
  );
  const {
    messages, activities, queuedInputs, sources, approvals, status, error, runId,
  } = conversation;
  const setConversationField = useCallback((key, value) => {
    dispatchConversation({ type: "set", key, value });
  }, []);
  const setMessages = useCallback((value) => setConversationField("messages", value), [setConversationField]);
  const setActivities = useCallback((value) => setConversationField("activities", value), [setConversationField]);
  const setQueuedInputs = useCallback((value) => setConversationField("queuedInputs", value), [setConversationField]);
  const setSources = useCallback((value) => setConversationField("sources", value), [setConversationField]);
  const setApprovals = useCallback((value) => setConversationField("approvals", value), [setConversationField]);
  const setStatus = useCallback((value) => setConversationField("status", value), [setConversationField]);
  const setError = useCallback((value) => setConversationField("error", value), [setConversationField]);
  const setRunId = useCallback((value) => setConversationField("runId", value), [setConversationField]);
  const [queueDelivery, setQueueDelivery] = useState("steer");
  const [draft, setDraftState] = useState("");
  const [uploads, setUploads] = useState([]);
  const [uploadError, setUploadError] = useState(null);
  const [startersLoading, setStartersLoading] = useState(false);
  const [startersError, setStartersError] = useState(null);
  const [thinkingLevel, setThinkingLevelState] = useState(readStoredThinkingLevel);
  const [transportRevision, bumpTransportRevision] = useReducer((value) => value + 1, 0);
  const [syncError, setSyncError] = useState(null);
  const approvalCommandsRef = useRef(new Set());
  // Invalidates snapshot reads when a newer read, event or selection wins.
  const hydrationRevisionRef = useRef(0);
  const synchronizationRevisionRef = useRef(0);
  const resourceVersionRef = useRef(resourceVersion);
  const resourceIdentityRef = useRef(resourceId);
  const activeThreadRef = useRef(null);
  const activeBranchRef = useRef(null);
  const threadsRef = useRef([]);
  const runtimeRef = useRef(null);
  const statusRef = useRef(status);
  const messagesRef = useRef([]);
  const approvalsRef = useRef([]);
  const runScopesRef = useRef(new Map());
  const streamControllersRef = useRef(new Map());
  const starterRequestsRef = useRef(new Set());
  const starterSuggestionsEnabledRef = useRef(starterSuggestionsEnabled);
  const uploadsRef = useRef([]);
  const threadCreationRef = useRef(null);
  // Keep canonical callbacks in refs so an unstable parent identity (e.g. inline
  // onCanonicalFramework) cannot invalidate loadMessages → selectThread and
  // re-run the mount effect, which briefly clears approvals and yanks StickToBottom.
  const onCanonicalDocumentRef = useRef(onCanonicalDocument);
  const onCanonicalFrameworkRef = useRef(onCanonicalFramework);
  const approval = activeApprovalFrom(approvals);
  const pendingInteraction = branches.find((branch) => branch.id === activeBranchId)?.pendingInteraction ?? null;
  resourceVersionRef.current = resourceVersion;
  resourceIdentityRef.current = resourceId;
  starterSuggestionsEnabledRef.current = starterSuggestionsEnabled;
  statusRef.current = status;
  onCanonicalDocumentRef.current = onCanonicalDocument;
  onCanonicalFrameworkRef.current = onCanonicalFramework;

  useEffect(() => { activeThreadRef.current = activeThreadId; }, [activeThreadId]);
  useEffect(() => { activeBranchRef.current = activeBranchId; }, [activeBranchId]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  useEffect(() => { runtimeRef.current = runtime; }, [runtime]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { approvalsRef.current = approvals; }, [approvals]);

  const replaceUploads = useCallback((nextOrUpdater) => {
    setUploads((current) => {
      const next = typeof nextOrUpdater === "function" ? nextOrUpdater(current) : nextOrUpdater;
      uploadsRef.current = next;
      return next;
    });
  }, []);

  const abandonDraftUploads = useCallback((draftUploads = uploadsRef.current) => {
    if (!draftUploads.length) return Promise.resolve();
    const abandonedIds = new Set(draftUploads.map((upload) => upload.id));
    uploadsRef.current = uploadsRef.current.filter((upload) => !abandonedIds.has(upload.id));
    return Promise.allSettled(
      draftUploads.map((upload) => agentApi.deleteKnowledgeUpload(upload.id)),
    ).then(() => undefined);
  }, []);

  useEffect(() => {
    const pending = uploads.filter((upload) => upload.status === "queued" || upload.status === "processing");
    if (!pending.length) return undefined;
    const timer = window.setTimeout(async () => {
      const settled = await Promise.all(pending.map(async (upload) => {
        try {
          return await agentApi.getKnowledgeUpload(upload.id);
        } catch (uploadError) {
          return { ...upload, status: "failed", metadata: { error: uploadError.message } };
        }
      }));
      const byId = new Map(settled.map((upload) => [upload.id, upload]));
      replaceUploads((current) => current.map((upload) => byId.get(upload.id) ?? upload));
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [replaceUploads, uploads]);

  useEffect(() => () => {
    const abandoned = uploadsRef.current;
    uploadsRef.current = [];
    void abandonDraftUploads(abandoned);
  }, [abandonDraftUploads, resourceId]);

  const setDraft = useCallback((value) => {
    setDraftState(value);
    window.localStorage.setItem(draftKey(activeThreadId), value);
  }, [activeThreadId]);

  const loadMessages = useCallback(async (threadId, branchId, { preservePresentation = false } = {}) => {
    const revision = ++hydrationRevisionRef.current;
    // The snapshot is the sole durable hydration boundary. It captures thread,
    // messages, approval and event journal at one server-owned consistency
    // point instead of composing several responses from different moments.
    const snapshot = await agentApi.getConversationSnapshot(threadId, branchId);
    const records = snapshot.messages ?? [];
    const approvalRecords = snapshot.approvals ?? [];
    const presentation = { run: snapshot.latestRun, events: snapshot.events ?? [] };
    if (
      revision !== hydrationRevisionRef.current
      || activeThreadRef.current !== threadId
      || activeBranchRef.current !== branchId
    ) {
      return null;
    }
    const presentedApprovals = approvalRecords;
    dispatchConversation({
      type: "hydrate",
      aggregateVersion: snapshot.aggregateVersion,
      throughSequence: snapshot.throughSequence,
      value: {
        messages: records,
        approvals: presentedApprovals,
        sources: latestAssistantSources(records),
        ...(!preservePresentation ? {
          activities: activitiesFromEvents(
            presentation.events ?? [],
            presentation.run?.status,
          ),
          queuedInputs: queuedInputsFromEvents(
            presentation.events ?? [],
            presentation.run?.status,
          ),
        } : {}),
      },
    });
    return { records, approvals: presentedApprovals, presentation, revision };
  }, []);

  const refreshCanonicalResource = useCallback(async () => {
    // Independent of transcript hydration: failure here is synchronization,
    // never evidence that the approval or the business write failed.
      if (resourceType === "semester_framework") {
        const framework = await agentApi.getSemesterFramework(resourceId);
        if (resourceIdentityRef.current !== resourceId) return;
        if (framework.framework.version > resourceVersionRef.current) {
          resourceVersionRef.current = framework.framework.version;
          onCanonicalFrameworkRef.current?.(framework);
        }
      } else {
        const file = await agentApi.getLessonFile(resourceId);
        if (resourceIdentityRef.current !== resourceId) return;
        if (file.documentVersion >= resourceVersionRef.current) {
          // Re-apply the same-version canonical snapshot as well. A prior live
          // event may have advanced the transport watermark before React
          // committed the editor projection; the durable refetch is the
          // convergence barrier after an approval decision.
          resourceVersionRef.current = file.documentVersion;
          onCanonicalDocumentRef.current?.(file);
        }
      }
  }, [resourceId, resourceType]);

  const ensureThreadStarters = useCallback(async (thread, hasMessages, { force = false } = {}) => {
    if (
      !thread
      || (!force && !starterSuggestionsEnabledRef.current)
      || hasMessages
      || (!force && (
        thread.starterSuggestions?.length
        && (resourceType === "semester_framework"
          ? thread.starterSuggestionsResourceVersion === resourceVersionRef.current
          : thread.starterSuggestionsDocumentVersion === resourceVersionRef.current)
      ))
      || starterRequestsRef.current.has(thread.id)
    ) return thread;
    starterRequestsRef.current.add(thread.id);
    if (activeThreadRef.current === thread.id) {
      setStartersLoading(true);
      setStartersError(null);
    }
    try {
      const updated = await agentApi.generateThreadStarters(thread.id);
      if (!updated.starterSuggestions?.length) throw new Error("thread_starters_empty");
      setThreads((current) => current.map((item) => item.id === updated.id ? updated : item));
      threadsRef.current = threadsRef.current.map((item) => item.id === updated.id ? updated : item);
      return updated;
    } catch (starterError) {
      if (activeThreadRef.current === thread.id) {
        setStartersError(starterError.message || "thread_starters_failed");
      }
      return thread;
    } finally {
      starterRequestsRef.current.delete(thread.id);
      if (activeThreadRef.current === thread.id) setStartersLoading(false);
    }
  }, [resourceType]);

  useEffect(() => {
    if (!starterSuggestionsEnabled || !activeThreadId) return;
    const activeThread = threads.find((thread) => thread.id === activeThreadId);
    void ensureThreadStarters(activeThread, Boolean(messagesRef.current.length));
  }, [activeThreadId, ensureThreadStarters, starterSuggestionsEnabled, threads]);

  const applyBranchPresentation = useCallback((threadId, branchId, loaded) => {
    if (
      !loaded || loaded.revision !== hydrationRevisionRef.current
      || activeThreadRef.current !== threadId
      || activeBranchRef.current !== branchId
    ) return;
    const localRun = [...runScopesRef.current.entries()].find(([, scope]) => (
      scope.threadId === threadId && scope.branchId === branchId
    ));
    const persistedRun = loaded?.presentation.run;
    if (["running", "queued"].includes(persistedRun?.status)) {
      runScopesRef.current.set(persistedRun.id, { threadId, branchId });
    }
    dispatchConversation({ type: "restore-runtime", value: {
      runtimeAvailable: runtimeRef.current?.agent,
      persistedRun,
      localRunId: localRun?.[0] ?? null,
      hasLocalStream: Boolean(localRun && streamControllersRef.current.has(threadId)),
    } });
  }, []);

  const synchronizeConversation = useCallback(async (scope = {
    threadId: activeThreadRef.current, branchId: activeBranchRef.current,
  }) => {
    const revision = ++synchronizationRevisionRef.current;
    const isCurrent = () => isAgentEventActive(scope, activeThreadRef.current, activeBranchRef.current);
    const results = await Promise.allSettled([
      (async () => {
        const loaded = await loadMessages(scope.threadId, scope.branchId);
        if (isCurrent()) applyBranchPresentation(scope.threadId, scope.branchId, loaded);
        return loaded;
      })(),
      refreshCanonicalResource(),
      agentApi.listThreads(resourceScope).then((records) => {
        if (!isCurrent()) return;
        threadsRef.current = records;
        setThreads(records);
      }),
    ]);
    if (isCurrent() && revision === synchronizationRevisionRef.current) {
      setSyncError(results.some((result) => result.status === "rejected") ? "conversation_sync_failed" : null);
    }
    return results[0].status === "fulfilled" ? results[0].value : null;
  }, [applyBranchPresentation, loadMessages, refreshCanonicalResource, resourceScope]);

  const selectThread = useCallback(async (threadId) => {
    ++hydrationRevisionRef.current;
    setSyncError(null);
    const abandoned = uploadsRef.current;
    uploadsRef.current = [];
    replaceUploads([]);
    void abandonDraftUploads(abandoned);
    activeThreadRef.current = threadId;
    setActiveThreadId(threadId);
    setApprovals([]);
    setUploadError(null);
    setStartersLoading(false);
    setStartersError(null);
    setActivities([]);
    setQueuedInputs([]);
    setSources([]);
    setRunId(null);
    setError(null);
    setStatus("loading");
    const records = await agentApi.listBranches(threadId);
    if (activeThreadRef.current !== threadId) return;
    setBranches(records);
    const selected = threadsRef.current.find((thread) => thread.id === threadId);
    const savedBranchId = window.localStorage.getItem(branchKey(threadId));
    const savedBranch = records.find((branch) => branch.id === savedBranchId);
    let pendingBranchId = null;
    if (selected?.status === "awaiting_approval") {
      const approvalSets = await Promise.all(records.map(async (branch) => ({
        branchId: branch.id,
        approvals: await agentApi.listApprovals(threadId, branch.id),
      })));
      if (activeThreadRef.current !== threadId) return;
      pendingBranchId = approvalSets.find((entry) => (
        entry.branchId === savedBranch?.id
        && entry.approvals.some((item) => item.state === "pending")
      ))?.branchId ?? approvalSets.find((entry) => (
        entry.approvals.some((item) => item.state === "pending")
      ))?.branchId ?? null;
    }
    const branchId = pendingBranchId ?? savedBranch?.id ?? records.at(-1)?.id;
    activeBranchRef.current = branchId ?? null;
    setActiveBranchId(branchId ?? null);
    if (branchId) window.localStorage.setItem(branchKey(threadId), branchId);
    setDraftState(window.localStorage.getItem(draftKey(threadId)) ?? "");
    const loaded = branchId ? await loadMessages(threadId, branchId) : null;
    if (loaded?.approvals.some((item) => item.state === "approved")) {
      void refreshCanonicalResource().catch(() => {
        if (activeThreadRef.current === threadId) setSyncError("conversation_sync_failed");
      });
    }
    void ensureThreadStarters(selected, Boolean(loaded?.records.length));
    applyBranchPresentation(threadId, branchId, loaded);
  }, [abandonDraftUploads, applyBranchPresentation, ensureThreadStarters, loadMessages, refreshCanonicalResource, replaceUploads]);

  const createThread = useCallback(async (force = false) => {
    if (
      force !== true
      && activeThreadRef.current
      && messagesRef.current.length === 0
      && statusRef.current !== "error"
    ) {
      return { created: false, reason: "current_thread_empty" };
    }
    const abandoned = uploadsRef.current;
    uploadsRef.current = [];
    replaceUploads([]);
    void abandonDraftUploads(abandoned);
    setStatus("loading");
    setError(null);
    const creationInput = {
      notebookId,
      ...resourceScope,
      currentThreadId: force === true ? undefined : activeThreadRef.current ?? undefined,
      currentBranchId: force === true ? undefined : activeBranchRef.current ?? undefined,
    };
    const creationSignature = JSON.stringify(creationInput);
    if (threadCreationRef.current?.signature !== creationSignature) {
      threadCreationRef.current = {
        signature: creationSignature,
        idempotencyKey: crypto.randomUUID(),
      };
    }
    let result;
    try {
      result = await agentApi.createThread(
        creationInput,
        threadCreationRef.current.idempotencyKey,
      );
      threadCreationRef.current = null;
    } catch (threadError) {
      setError(threadError.message);
      setStatus("error");
      throw threadError;
    }
    activeThreadRef.current = result.thread.id;
    activeBranchRef.current = result.branch.id;
    setThreads((current) => [result.thread, ...current]);
    threadsRef.current = [result.thread, ...threadsRef.current];
    setActiveThreadId(result.thread.id);
    setBranches([result.branch]);
    setActiveBranchId(result.branch.id);
    window.localStorage.setItem(branchKey(result.thread.id), result.branch.id);
    setMessages([]);
    setActivities([]);
    setQueuedInputs([]);
    setSources([]);
    setDraftState("");
    setUploadError(null);
    setStartersError(null);
    resetAgentConversationState({
      runtime: runtimeRef.current,
      setApproval: (value) => setApprovals(value ? [value] : []),
      setError,
      setRunId,
      setStatus,
    });
    void ensureThreadStarters(result.thread, false);
    return { ...result, created: true };
  }, [abandonDraftUploads, ensureThreadStarters, notebookId, replaceUploads, resourceScope]);

  const updateActiveThread = useCallback(async (patch) => {
    if (!activeThreadId) return null;
    const updated = await agentApi.updateThread(activeThreadId, patch);
    setThreads((current) => current.map((thread) => thread.id === updated.id ? updated : thread));
    return updated;
  }, [activeThreadId]);

  const removeActiveThread = useCallback(async (kind) => {
    if (!activeThreadId) return;
    if (kind === "archive") await agentApi.updateThread(activeThreadId, { archived: true });
    else await agentApi.deleteThread(activeThreadId);
    const records = await agentApi.listThreads(resourceScope);
    setThreads(records);
    if (records[0]) await selectThread(records[0].id);
    else await createThread(true);
  }, [activeThreadId, createThread, resourceScope, selectThread]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setStatus("loading");
      setError(null);
      try {
        const nextRuntime = await agentApi.runtime();
        if (cancelled) return;
        runtimeRef.current = nextRuntime;
        setRuntime(nextRuntime);
        const records = await agentApi.listThreads(resourceScope);
        if (cancelled) return;
        threadsRef.current = records;
        setThreads(records);
        if (records[0]) await selectThread(records[0].id);
        else await createThread(true);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus("error");
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      for (const controller of streamControllersRef.current.values()) controller.abort();
      streamControllersRef.current.clear();
    };
  }, [createThread, resourceScope, selectThread]);

  const handleEvent = useCallback((event, explicitScope = null) => {
    if (event.type === "run.started") {
      runScopesRef.current.set(event.runId, { threadId: event.threadId, branchId: event.branchId });
      setThreads((current) => current.map((thread) => thread.id === event.threadId ? { ...thread, status: "running" } : thread));
      const isActive = activeThreadRef.current === event.threadId && activeBranchRef.current === event.branchId;
      if (!isActive) return;
      setRunId(event.runId);
      setStatus("streaming");
      setSources([]);
      setMessages((current) => {
        const index = current.findLastIndex((message) => (
          message.role === "assistant" && message.status === "streaming"
        ));
        const turn = {
          runId: event.runId,
          status: "running",
          phase: "preparing",
          // The user-facing duration measures one request, from send to its
          // terminal state. Do not reset it when the server acknowledges run
          // creation, or the UI appears to start a second timer.
          startedAt: index >= 0
            ? current[index].turn?.startedAt ?? event.startedAt ?? new Date().toISOString()
            : event.startedAt ?? new Date().toISOString(),
        };
        if (index < 0) {
          return [...current, {
            id: `stream-${event.runId}`,
            role: "assistant",
            content: "",
            status: "streaming",
            turn,
          }];
        }
        const next = [...current];
        next[index] = { ...next[index], turn };
        return next;
      });
    }
    if (event.type === "thread.updated") {
      setThreads((current) => current.map((thread) => (
        thread.id === event.thread.id ? event.thread : thread
      )));
      threadsRef.current = threadsRef.current.map((thread) => (
        thread.id === event.thread.id ? event.thread : thread
      ));
    }
    const scope = resolveAgentEventScope(runScopesRef.current, event, explicitScope);
    const isActive = isAgentEventActive(
      scope,
      activeThreadRef.current,
      activeBranchRef.current,
    );
    if (isActive) ++hydrationRevisionRef.current;
    if (isActive && ["approval.required", "approval.decided", "approval.delivered", "run.completed", "run.cancelled"].includes(event.type)) {
      dispatchConversation({ type: "approval-event", event });
    }
    if (isActive && event.type === "agent.started") {
      setMessages((current) => updateActiveAssistantTurn(current, event.runId, {
        status: "running",
        phase: "preparing",
      }));
    }
    if (isActive && event.type === "turn.started") {
      setMessages((current) => updateActiveAssistantTurn(current, event.runId, {
        status: "running",
        phase: "responding",
        currentTurn: event.turn,
      }));
    }
    if (isActive && event.type === "assistant.message.started") {
      setMessages((current) => updateActiveAssistantTurn(current, event.runId, {
        status: "running",
        phase: "responding",
        currentTurn: event.turn,
      }));
    }
    if (isActive && event.type === "assistant.message.ended") {
      setMessages((current) => updateActiveAssistantTurn(current, event.runId, {
        currentTurn: event.turn,
      }));
    }
    if (isActive && event.type === "turn.ended") {
      setMessages((current) => updateActiveAssistantTurn(current, event.runId, {
        currentTurn: event.turn,
      }));
    }
    if (event.type === "document.updated") {
      if (
        resourceType === "lesson_file"
        && event.file.id === resourceId
        && event.file.documentVersion > resourceVersionRef.current
      ) {
        resourceVersionRef.current = event.file.documentVersion;
        onCanonicalDocumentRef.current?.(event.file);
      }
    }
    if (
      event.type === "resource.updated"
      && resourceType === "semester_framework"
      && event.resourceType === "semester_framework"
      && event.framework.framework.id === resourceId
      && event.framework.framework.version > resourceVersionRef.current
    ) {
      resourceVersionRef.current = event.framework.framework.version;
      onCanonicalFrameworkRef.current?.(event.framework);
    }
    if (event.type === "message.delta") {
      if (!isActive) return;
      setMessages((current) => {
        const index = current.findLastIndex((message) => message.role === "assistant" && message.status === "streaming");
        if (index < 0) return [...current, {
          id: `stream-${event.runId}`,
          role: "assistant",
          content: event.delta,
          status: "streaming",
          turnTexts: typeof event.turn === "number" ? { [event.turn]: event.delta } : undefined,
          turn: { runId: event.runId, status: "running", phase: "responding", startedAt: new Date().toISOString() },
        }];
        const next = [...current];
        next[index] = {
          ...next[index],
          content: `${next[index].content}${event.delta}`,
          turnTexts: typeof event.turn === "number"
            ? {
                ...next[index].turnTexts,
                [event.turn]: `${next[index].turnTexts?.[event.turn] ?? ""}${event.delta}`,
              }
            : next[index].turnTexts,
        };
        return next;
      });
    }
    if (event.type === "message.turn_text") {
      if (!isActive) return;
      setMessages((current) => {
        const index = current.findLastIndex((message) => (
          message.role === "assistant"
          && (message.status === "streaming" || message.turn?.runId === event.runId)
        ));
        if (index < 0) return current;
        const next = [...current];
        next[index] = {
          ...next[index],
          turnTexts: { ...next[index].turnTexts, [event.turn]: event.text },
        };
        return next;
      });
    }
    if (event.type === "agent.input.queued") {
      if (!isActive) return;
      setQueuedInputs((current) => [
        ...current.filter((item) => item.id !== event.queueId),
        {
          id: event.queueId,
          content: event.content,
          delivery: event.delivery,
          state: "queued",
        },
      ]);
    }
    if (event.type === "agent.input.cleared") {
      if (!isActive) return;
      setQueuedInputs((current) => current.filter((item) => (
        event.delivery !== "all" && item.delivery !== event.delivery
      )));
    }
    if (event.type === "tool.started") {
      if (!isActive) return;
      setMessages((current) => updateActiveAssistantTurn(current, event.runId, {
        phase: "using_tools",
        currentTurn: event.turn,
      }));
      setActivities((current) => [...current, {
        id: event.toolCallId,
        name: event.name,
        label: event.label,
        detail: event.detail,
        groupKey: event.groupKey,
        state: "running",
        turn: event.turn,
      }]);
    }
    if (event.type === "tool.updated") {
      if (!isActive) return;
      setActivities((current) => current.map((activity) => activity.id === event.toolCallId
        ? {
            ...activity,
            label: event.label ?? activity.label,
            detail: event.detail ?? activity.detail,
            progress: event.progress ?? activity.progress,
            turn: event.turn ?? activity.turn,
          }
        : activity));
    }
    if (event.type === "tool.completed") {
      if (!isActive) return;
      setActivities((current) => {
        const approvalBackedToolCalls = approvalBackedToolCallIds(
          current,
          approvalsRef.current.filter((item) => item.runId === event.runId),
        );
        return current.map((activity) => activity.id === event.toolCallId
          ? {
            ...activity,
            state: activityStateForToolCompletion(event, { approvalBackedToolCalls }),
            label: event.label,
            detail: event.detail ?? activity.detail,
            groupKey: event.groupKey ?? activity.groupKey,
            outcome: event.outcome,
            revisionCode: event.revisionCode,
            turn: event.turn ?? activity.turn,
          }
          : activity);
      });
    }
    if (event.type === "source.added") {
      if (!isActive) return;
      setSources((current) => dedupeAgentSources([...current, event.source]));
    }
    if (event.type === "approval.required") {
      if (scope) setThreads((current) => current.map((thread) => thread.id === scope.threadId ? { ...thread, status: "awaiting_approval" } : thread));
      if (!isActive) return;
      setActivities((current) => current.map((activity) => (
        activity.state === "running" ? { ...activity, state: "completed", outcome: "completed" } : activity
      )));
    }
    if (event.type === "message.completed") {
      if (!isActive) return;
      setMessages((current) => {
        const streaming = current.findLast((message) => (
          message.role === "assistant" && message.status === "streaming"
        ));
        const completed = {
          ...event.message,
          turn: event.message.turn ?? streaming?.turn,
        };
        const withoutStream = current.filter((message) => message.status !== "streaming");
        return withoutStream.some((message) => message.id === event.message.id)
          ? withoutStream.map((message) => message.id === event.message.id ? completed : message)
          : [...withoutStream, completed];
      });
    }
    if (event.type === "run.completed" || event.type === "run.cancelled") {
      if (scope) setThreads((current) => current.map((thread) => thread.id === scope.threadId ? { ...thread, status: "idle" } : thread));
      if (isActive) {
        const completedAt = new Date().toISOString();
        setMessages((current) => {
          const index = current.findLastIndex((message) => (
            message.role === "assistant"
            && (message.turn?.runId === event.runId || !message.turn?.runId)
          ));
          if (index < 0) return current;
          const next = [...current];
          next[index] = {
            ...next[index],
            turn: {
              ...next[index].turn,
              runId: event.runId,
              status: event.type === "run.completed" ? "completed" : "cancelled",
              startedAt: next[index].turn?.startedAt ?? completedAt,
              completedAt,
            },
          };
          return next;
        });
        if (event.type === "run.completed") {
          setActivities((current) => current.map((activity) => (
            activity.state === "running" ? { ...activity, state: "completed" } : activity
          )));
          setQueuedInputs((current) => current.map((item) => ({ ...item, state: "completed" })));
        } else {
          setActivities((current) => current.map((activity) => (
            activity.state === "running"
              ? { ...activity, state: "cancelled", outcome: "cancelled" }
              : activity
          )));
          setQueuedInputs((current) => current.map((item) => ({ ...item, state: "cancelled" })));
        }
        setStatus("ready");
        setRunId(null);
      }
      // Presentation theme selection is a durable branch interaction. Refresh
      // it after the turn that creates or resolves it instead of guessing from
      // the assistant's Markdown response.
      if (scope?.threadId === activeThreadRef.current) {
        void agentApi.listBranches(scope.threadId)
          .then((records) => {
            if (activeThreadRef.current === scope.threadId) setBranches(records);
          })
          .catch(() => undefined);
      }
      runScopesRef.current.delete(event.runId);
    }
    if (event.type === "run.failed") {
      if (scope) setThreads((current) => current.map((thread) => thread.id === scope.threadId ? { ...thread, status: "idle" } : thread));
      if (isActive) {
        setActivities((current) => current.map((activity) => (
          activity.state === "running" ? { ...activity, state: "failed" } : activity
        )));
        setQueuedInputs((current) => current.map((item) => ({ ...item, state: "failed" })));
        setMessages((current) => {
          const failedAt = new Date().toISOString();
          if (event.message) {
            const withoutStream = current.filter((message) => message.status !== "streaming");
            const streaming = current.findLast((message) => (
              message.role === "assistant" && message.status === "streaming"
            ));
            const failedMessage = {
              ...event.message,
              turn: {
                ...streaming?.turn,
                ...event.message.turn,
                runId: event.runId,
                status: "failed",
                startedAt: event.message.turn?.startedAt ?? streaming?.turn?.startedAt ?? failedAt,
                completedAt: failedAt,
              },
            };
            return withoutStream.some((message) => message.id === event.message.id)
              ? withoutStream.map((message) => (
                  message.id === event.message.id ? failedMessage : message
                ))
              : [...withoutStream, failedMessage];
          }
          const index = current.findLastIndex((message) => (
            message.role === "assistant" && message.status === "streaming"
          ));
          if (index < 0) return current;
          const next = [...current];
          next[index] = {
            ...next[index],
            status: "failed",
            error: event.error,
            turn: {
              ...next[index].turn,
              runId: event.runId,
              status: "failed",
              startedAt: next[index].turn?.startedAt ?? failedAt,
              completedAt: failedAt,
            },
          };
          return next;
        });
        setError(null);
        setStatus(runtimeRef.current?.agent ? "ready" : "unconfigured");
        setRunId(null);
      }
      runScopesRef.current.delete(event.runId);
    }
  }, [resourceId, resourceType]);

  useEffect(() => {
    // A POST stream is the live owner while it exists. Starting a second
    // polling transport for the same run races durable hydration against
    // incoming deltas and doubles the read load on every active turn.
    if (!shouldRecoverConversation({
      status,
      runId,
      threadId: activeThreadId,
      branchId: activeBranchId,
      hasLocalStream: Boolean(
        activeThreadId && streamControllersRef.current.has(activeThreadId)
      ),
    })) return undefined;
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        // One server snapshot is the recovery boundary. Do not stitch an
        // activity response and a later message response into a state that
        // never existed on the server.
        const loaded = await loadMessages(activeThreadId, activeBranchId);
        const presentation = loaded?.presentation;
        if (cancelled) return;
        if (presentation?.run?.id !== runId) {
          applyBranchPresentation(activeThreadId, activeBranchId, loaded);
          return;
        }
        const runStatus = presentation.run.status;
        if (runStatus === "running" || runStatus === "queued") {
          applyBranchPresentation(activeThreadId, activeBranchId, loaded);
          timer = window.setTimeout(poll, 1_000);
          return;
        }
        runScopesRef.current.delete(runId);
        applyBranchPresentation(activeThreadId, activeBranchId, loaded);
        // Auxiliary reads do not delay settlement or create an execution retry.
        void synchronizeConversation({ threadId: activeThreadId, branchId: activeBranchId });
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 1_500);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeBranchId, activeThreadId, applyBranchPresentation, loadMessages, synchronizeConversation, runId, status, transportRevision]);

  const send = useCallback(async (message = draft, options = {}) => {
    if (statusRef.current === "syncing") return;
    const pendingInteractionSnapshot = pendingInteraction;
    if (agentInputDisposition(statusRef.current, pendingInteractionSnapshot) === "queue") {
      const content = message.trim();
      if (!content || !runId || uploads.length) return;
      setDraft("");
      setError(null);
      try {
        const queued = await agentApi.queueRunInput(runId, {
          content,
          delivery: queueDelivery,
        });
        setQueuedInputs((current) => [
          ...current.filter((item) => item.id !== queued.queueId),
          { id: queued.queueId, content: queued.content, delivery: queued.delivery, state: "queued" },
        ]);
      } catch (queueError) {
        setDraft(content);
        setError(queueError.message);
      }
      return;
    }
    const continuation = options.continuation === true;
    const attachmentSnapshot = continuation ? [] : readyUploadSources(uploads);
    if (
      hasBlockingUploads(uploads)
      || (!message.trim() && !attachmentSnapshot.length)
      || !activeThreadId
      || !activeBranchId
      || !runtime?.agent
    ) return;
    const prompt = message.trim() || "请阅读并概括随消息附带的资料。";
    const uploadDraftSnapshot = uploads;
    const optimisticUserId = `optimistic-${crypto.randomUUID()}`;
    const optimisticAssistantId = `optimistic-${crypto.randomUUID()}`;
    const requestScope = {
      threadId: activeThreadId,
      branchId: activeBranchId,
    };
    if (pendingInteractionSnapshot?.kind === "presentation_theme") {
      setBranches((current) => current.map((branch) => (
        branch.id === requestScope.branchId ? { ...branch, pendingInteraction: null } : branch
      )));
    }
    const requestSectionId = activeSectionId;
    const requestSelection = selection;
    const controller = new AbortController();
    streamControllersRef.current.set(requestScope.threadId, controller);
    bumpTransportRevision();
    setDraft("");
    uploadsRef.current = [];
    replaceUploads([]);
    setError(null);
    setActivities([]);
    setQueuedInputs([]);
    setSources([]);
    setRunId(null);
    setStatus("streaming");
    setMessages((current) => [
      ...current,
      ...(continuation ? [] : [{
        id: optimisticUserId,
        role: "user",
        content: prompt,
        status: "completed",
        sources: attachmentSnapshot,
      }]),
      {
        id: optimisticAssistantId,
        role: "assistant",
        content: "",
        status: "streaming",
        turn: { status: "running", phase: "starting", startedAt: new Date().toISOString() },
      },
    ]);
    let requestResourceVersion;
    try {
      const flushed = await onBeforeRun?.();
      requestResourceVersion = resourceType === "semester_framework"
        ? flushed?.framework?.version ?? flushed?.frameworkVersion ?? resourceVersionRef.current
        : flushed?.documentVersion ?? resourceVersionRef.current;
      resourceVersionRef.current = requestResourceVersion;
    } catch {
      setMessages((current) => current.filter((item) => (
        item.id !== optimisticUserId && item.id !== optimisticAssistantId
      )));
      if (!continuation) setDraft(message);
      replaceUploads(uploadDraftSnapshot);
      if (pendingInteractionSnapshot?.kind === "presentation_theme") {
        setBranches((current) => current.map((branch) => (
          branch.id === requestScope.branchId ? { ...branch, pendingInteraction: pendingInteractionSnapshot } : branch
        )));
      }
      streamControllersRef.current.delete(requestScope.threadId);
      setError("document_save_failed");
      setStatus("error");
      return;
    }
    try {
      const clientCommandId = crypto.randomUUID();
      await consumeAgentStream(`/api/agent/threads/${requestScope.threadId}/runs`, {
        branchId: requestScope.branchId,
        message: prompt,
        activeSectionId: requestSectionId,
        activeUnitId: resourceType === "semester_framework" ? activeUnitId || undefined : undefined,
        documentVersion: requestResourceVersion,
        selection: resourceType === "lesson_file" ? requestSelection || undefined : undefined,
        attachmentIds: attachmentSnapshot.map((attachment) => attachment.id),
        continuation,
        generationIntentId: options.generationIntentId,
        frameworkWritebackIntentId: options.frameworkWritebackIntentId,
        thinkingLevel,
        clientCommandId,
      }, (event) => handleEvent(event, requestScope), {
        signal: controller.signal,
        idempotencyKey: clientCommandId,
      });
      const records = await synchronizeCompletedAgentTurn({
        threadId: requestScope.threadId,
        branchId: requestScope.branchId,
        loadMessages,
        listThreads: () => agentApi.listThreads(resourceScope),
      });
      setThreads(records);
    } catch (streamError) {
      if (streamError.name !== "AbortError") {
        try {
          if (
            activeThreadRef.current !== requestScope.threadId
            || activeBranchRef.current !== requestScope.branchId
          ) return;
          const loaded = await loadMessages(requestScope.threadId, requestScope.branchId);
          const presentation = loaded?.presentation;
          const persistedRun = presentation?.run;
          if (persistedRun?.status === "running" || persistedRun?.status === "queued") {
            runScopesRef.current.set(persistedRun.id, {
              threadId: requestScope.threadId,
              branchId: requestScope.branchId,
            });
            setRunId(persistedRun.id);
            setActivities(activitiesFromEvents(
              presentation.events ?? [],
              persistedRun.status,
            ));
            setStatus("streaming");
          } else if (persistedRun?.status === "failed") {
            setError(null);
            setStatus(runtimeRef.current?.agent ? "ready" : "unconfigured");
          } else {
            setError(persistedRun?.error ?? streamError.message);
            setStatus("error");
          }
        } catch {
          setError(streamError.message);
          setStatus("error");
        }
      }
    } finally {
      if (streamControllersRef.current.get(requestScope.threadId) === controller) {
        streamControllersRef.current.delete(requestScope.threadId);
        bumpTransportRevision();
      }
      try {
        const branchRecords = await agentApi.listBranches(requestScope.threadId);
        if (activeThreadRef.current === requestScope.threadId) setBranches(branchRecords);
      } catch {
        // The optimistic theme choice remains hidden; the next branch hydration
        // reconciles the server-owned interaction without reviving stale UI.
      }
    }
  }, [activeBranchId, activeSectionId, activeThreadId, activeUnitId, draft, handleEvent, loadMessages, onBeforeRun, pendingInteraction, queueDelivery, replaceUploads, resourceScope, resourceType, runId, runtime?.agent, selection, setDraft, thinkingLevel, uploads]);

  const clearQueuedInputs = useCallback(async (delivery = "all") => {
    if (!runId) return;
    await agentApi.clearRunInput(runId, delivery);
    setQueuedInputs((current) => current.filter((item) => (
      delivery !== "all" && item.delivery !== delivery
    )));
  }, [runId]);

  const stop = useCallback(async () => {
    const stoppedRunId = runId;
    const stoppedThreadId = activeThreadId;
    const stoppedBranchId = activeBranchId;
    await stopAgentRun({
      runId: stoppedRunId,
      cancelRun: agentApi.cancelRun,
      controller: streamControllersRef.current.get(stoppedThreadId),
      reloadMessages: () => stoppedThreadId && stoppedBranchId
        ? loadMessages(stoppedThreadId, stoppedBranchId)
        : Promise.resolve(),
    });
    if (stoppedRunId) runScopesRef.current.delete(stoppedRunId);
    if (stoppedThreadId) streamControllersRef.current.delete(stoppedThreadId);
    const nextThreads = threadsRef.current.map((thread) => (
      thread.id === stoppedThreadId ? { ...thread, status: "idle" } : thread
    ));
    threadsRef.current = nextThreads;
    setThreads(nextThreads);
    if (activeThreadRef.current === stoppedThreadId) {
      setRunId(null);
      setError(null);
      setStatus(runtimeRef.current?.agent ? "ready" : "unconfigured");
    }
    const persistedThreads = await agentApi.listThreads(resourceScope);
    threadsRef.current = persistedThreads;
    setThreads(persistedThreads);
  }, [activeBranchId, activeThreadId, loadMessages, resourceScope, runId, runtime?.agent]);

  const respondApproval = useCallback(async (approved) => {
    if (!approval || !["pending", "recoverable"].includes(approvalPhase(approval))
      || approvalCommandsRef.current.has(approval.id)) return;
    const requestScope = {
      threadId: activeThreadRef.current,
      branchId: activeBranchRef.current,
    };
    const isCurrent = () => isAgentEventActive(requestScope, activeThreadRef.current, activeBranchRef.current);
    // Acquire before flushing the editor: React has not disabled the button yet.
    approvalCommandsRef.current.add(approval.id);
    try {
      const flushed = await onBeforeRun?.();
      const flushedVersion = resourceType === "semester_framework"
        ? flushed?.framework?.version ?? flushed?.frameworkVersion
        : flushed?.documentVersion;
      if (flushedVersion !== undefined) {
        resourceVersionRef.current = flushedVersion;
      }
    } catch {
      approvalCommandsRef.current.delete(approval.id);
      if (isCurrent()) {
        setError("document_save_failed");
        setStatus("awaiting_approval");
      }
      return;
    }
    if (!isCurrent()) {
      approvalCommandsRef.current.delete(approval.id);
      return;
    }
    setError(null);
    setSyncError(null);
    setApprovals((current) => current.map((item) => (
      item.id === approval.id
        ? { ...item, transport: "submitting" }
        : item
    )));
    setStatus("streaming");
    setRunId(approval.runId);
    runScopesRef.current.set(approval.runId, requestScope);
    const controller = new AbortController();
    streamControllersRef.current.set(requestScope.threadId, controller);
    const idempotencyKey = crypto.randomUUID();
    try {
      const result = await executeApprovalCommand({
        execute: (onEvent) => consumeAgentStream(
          `/api/agent/runs/${approval.runId}/approvals/${approval.id}`,
          { approved }, onEvent, { idempotencyKey, signal: controller.signal },
        ),
        onEvent: (event) => handleEvent(event, requestScope),
        synchronize: () => synchronizeConversation(requestScope),
      });
      if (isCurrent() && result.transportError && !result.terminal
        && result.synchronization?.approvals.some((item) => item.id === approval.id && item.state === "pending")) {
        setError(result.transportError.message);
      }
      if (isCurrent() && !result.synchronization) {
        // Unknown is a read-recovery state, not permission to execute again.
        dispatchConversation({ type: "approval-sync-unavailable", approvalId: approval.id });
      }
    } finally {
      approvalCommandsRef.current.delete(approval.id);
      if (streamControllersRef.current.get(requestScope.threadId) === controller) {
        streamControllersRef.current.delete(requestScope.threadId);
      }
      bumpTransportRevision();
    }
  }, [approval, handleEvent, onBeforeRun, resourceType, synchronizeConversation]);

  const switchBranch = useCallback(async (branchId) => {
    if (!activeThreadId) return;
    ++hydrationRevisionRef.current;
    setSyncError(null);
    activeBranchRef.current = branchId;
    setActiveBranchId(branchId);
    window.localStorage.setItem(branchKey(activeThreadId), branchId);
    setApprovals([]);
    setActivities([]);
    setQueuedInputs([]);
    setSources([]);
    setRunId(null);
    setError(null);
    setStatus("loading");
    const loaded = await loadMessages(activeThreadId, branchId);
    applyBranchPresentation(activeThreadId, branchId, loaded);
  }, [activeThreadId, applyBranchPresentation, loadMessages]);

  const branchFromMessage = useCallback(async (message, editedContent) => {
    if (!activeThreadId || !activeBranchId) return;
    const source = await resolveBranchSourceMessage(
      message,
      () => agentApi.listMessages(activeThreadId, activeBranchId),
    );
    if (source.records) setMessages(source.records);
    const branch = await agentApi.createBranch(source.message.id, {
      threadId: activeThreadId,
      branchId: activeBranchId,
    });
    setBranches((current) => [...current, branch]);
    activeBranchRef.current = branch.id;
    setActiveBranchId(branch.id);
    window.localStorage.setItem(branchKey(activeThreadId), branch.id);
    await loadMessages(activeThreadId, branch.id);
    if (editedContent !== undefined) setDraft(editedContent);
  }, [activeBranchId, activeThreadId, loadMessages, setDraft]);

  const retry = useCallback(() => {
    const message = lastRetryableUserMessage(messages);
    if (!message) return;
    setError(null);
    void send(message.content, { continuation: true });
  }, [messages, send]);

  const setThinkingLevel = useCallback((value) => {
    setThinkingLevelState(persistThinkingLevel(value));
  }, []);

  const retryStarters = useCallback(() => {
    const thread = threadsRef.current.find((item) => item.id === activeThreadRef.current);
    if (!thread || messagesRef.current.length) return;
    void ensureThreadStarters(thread, false, { force: true });
  }, [ensureThreadStarters]);

  const uploadKnowledge = useCallback(async (file) => {
    setUploadError(null);
    try {
      if (resourceType !== "lesson_file") {
        throw new Error("knowledge_upload_not_supported_for_resource");
      }
      const source = await agentApi.uploadKnowledge(file, { notebookId, lessonFileId: resourceId });
      replaceUploads((current) => [...current, source]);
      return source;
    } catch (uploadError) {
      setUploadError(uploadError.message);
      throw uploadError;
    }
  }, [notebookId, replaceUploads, resourceId, resourceType]);

  const dismissUpload = useCallback(async (sourceId) => {
    await agentApi.deleteKnowledgeUpload(sourceId);
    replaceUploads((current) => current.filter((upload) => upload.id !== sourceId));
    setUploadError(null);
  }, [replaceUploads]);

  const retryUpload = useCallback(async (sourceId) => {
    const source = await agentApi.retryKnowledgeUpload(sourceId);
    replaceUploads((current) => current.map((upload) => upload.id === sourceId ? source : upload));
    setUploadError(null);
  }, [replaceUploads]);

  return {
    runtime, threads, activeThreadId, branches, activeBranchId, messages,
    activities, queuedInputs, queueDelivery, sources, approvals, approval, pendingInteraction, status, error, syncError, uploadError, runId, draft, uploads,
    startersLoading, startersError, thinkingLevel,
    setDraft, setThinkingLevel, setQueueDelivery, send, retry, stop, clearQueuedInputs, respondApproval, synchronizeConversation, selectThread, switchBranch, createThread, branchFromMessage,
    updateActiveThread, removeActiveThread, uploadKnowledge, dismissUpload, retryUpload, retryStarters,
  };
}
