import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentApi, consumeAgentStream } from "@/lib/agent-api";
import {
  activitiesFromEvents,
  activityStateForToolCompletion,
  agentInputDisposition,
  canRetryApprovalDecision,
  deriveBranchRuntimeState,
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

const draftKey = (threadId) => `lessonup:agent-draft:${threadId ?? "new"}`;
const branchKey = (threadId) => `lessonup:agent-branch:${threadId}`;

function sourcesFromEvents(events) {
  return dedupeAgentSources(events
    .filter((event) => event.type === "source.added")
    .map((event) => event.source));
}

function presentApproval(record) {
  const decision = record.state === "approved" || record.state === "rejected"
    ? record.state
    : null;
  if (record.continuationStatus === "running") {
    return { ...record, state: "responding", decision };
  }
  if (record.continuationStatus === "ready") {
    return { ...record, state: "continuation", decision };
  }
  return { ...record, decision };
}

function activeApprovalFrom(records) {
  return [...records].reverse().find((item) => (
    (item.state === "pending"
      || item.state === "responding"
      || item.state === "continuation")
    && !(item.state === "continuation"
      && item.patch?.kind === "presentation_storyboard"
      && !item.patch.goal)
  )) ?? null;
}

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
  const [messages, setMessages] = useState([]);
  const [activities, setActivities] = useState([]);
  const [queuedInputs, setQueuedInputs] = useState([]);
  const [queueDelivery, setQueueDelivery] = useState("steer");
  const [sources, setSources] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [runId, setRunId] = useState(null);
  const [draft, setDraftState] = useState("");
  const [uploads, setUploads] = useState([]);
  const [uploadError, setUploadError] = useState(null);
  const [startersLoading, setStartersLoading] = useState(false);
  const [startersError, setStartersError] = useState(null);
  const resourceVersionRef = useRef(resourceVersion);
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

  useEffect(() => {
    if (
      approval?.state === "pending"
      || approval?.state === "continuation"
    ) {
      setStatus("awaiting_approval");
    }
  }, [approval?.state]);

  const setDraft = useCallback((value) => {
    setDraftState(value);
    window.localStorage.setItem(draftKey(activeThreadId), value);
  }, [activeThreadId]);

  const loadMessages = useCallback(async (threadId, branchId, { preservePresentation = false } = {}) => {
    // Activity recovery may atomically settle an expired run and its owning
    // assistant message. Read it first so message hydration cannot race the
    // recovery transaction and render a stale, permanently streaming turn.
    const presentation = await agentApi.getLatestActivity(threadId, branchId);
    const [records, approvalRecords] = await Promise.all([
      agentApi.listMessages(threadId, branchId),
      agentApi.listApprovals(threadId, branchId),
    ]);
    if (
      activeThreadRef.current !== threadId
      || activeBranchRef.current !== branchId
    ) {
      return null;
    }
    setMessages(records);
    if (!preservePresentation) {
      setActivities(activitiesFromEvents(
        presentation.events ?? [],
        presentation.run?.status,
      ));
      setQueuedInputs(queuedInputsFromEvents(
        presentation.events ?? [],
        presentation.run?.status,
      ));
    }
    setSources(latestAssistantSources(records));
    const presentedApprovals = approvalRecords.map(presentApproval);
    setApprovals(presentedApprovals);
    if (presentedApprovals.some((item) => item.state === "approved")) {
      if (resourceType === "semester_framework") {
        const framework = await agentApi.getSemesterFramework(resourceId);
        if (framework.framework.version > resourceVersionRef.current) {
          resourceVersionRef.current = framework.framework.version;
          onCanonicalFrameworkRef.current?.(framework);
        }
      } else {
        const file = await agentApi.getLessonFile(resourceId);
        if (file.documentVersion > resourceVersionRef.current) {
          resourceVersionRef.current = file.documentVersion;
          onCanonicalDocumentRef.current?.(file);
        }
      }
    }
    return { records, approvals: presentedApprovals, presentation };
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

  const applyBranchPresentation = useCallback((threadId, branchId, loaded) => {
    if (
      activeThreadRef.current !== threadId
      || activeBranchRef.current !== branchId
    ) return;
    const localRun = [...runScopesRef.current.entries()].find(([, scope]) => (
      scope.threadId === threadId && scope.branchId === branchId
    ));
    const persistedRun = loaded?.presentation.run;
    const next = deriveBranchRuntimeState({
      runtimeAvailable: runtimeRef.current?.agent,
      approvals: loaded?.approvals,
      persistedRun,
      localRunId: localRun?.[0] ?? null,
      hasLocalStream: Boolean(
        localRun && streamControllersRef.current.has(threadId)
      ),
    });
    if (next.runId) {
      runScopesRef.current.set(next.runId, { threadId, branchId });
    }
    setRunId(next.runId);
    setError(next.error);
    setStatus(next.status);
  }, []);

  const selectThread = useCallback(async (threadId) => {
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
    void ensureThreadStarters(selected, Boolean(loaded?.records.length));
    applyBranchPresentation(threadId, branchId, loaded);
  }, [abandonDraftUploads, applyBranchPresentation, ensureThreadStarters, loadMessages, replaceUploads]);

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
        const turn = {
          runId: event.runId,
          status: "running",
          phase: "preparing",
          startedAt: event.startedAt ?? new Date().toISOString(),
        };
        const index = current.findLastIndex((message) => (
          message.role === "assistant" && message.status === "streaming"
        ));
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
          turn: { runId: event.runId, status: "running", phase: "responding", startedAt: new Date().toISOString() },
        }];
        const next = [...current];
        next[index] = { ...next[index], content: `${next[index].content}${event.delta}` };
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
        const approvalCreated = approvalsRef.current.some((item) => (
          item.runId === event.runId
        ));
        const approvalDecided = approvalsRef.current.some((item) => (
          item.runId === event.runId
          && (item.decision === "approved"
            || item.decision === "rejected"
            || item.state === "responding"
            || item.state === "approved"
            || item.state === "rejected"
            || item.state === "continuation")
        ));
        return current.map((activity) => activity.id === event.toolCallId
          ? {
            ...activity,
            state: activityStateForToolCompletion(event, {
              approvalCreated,
              approvalDecided,
            }),
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
      setApprovals((current) => [
        ...current.filter((item) => item.id !== event.approvalId),
        {
          id: event.approvalId,
          runId: event.runId,
          assistantMessageId: event.assistantMessageId,
          patch: event.patch,
          state: "pending",
          decision: null,
        },
      ]);
      setActivities((current) => current.map((activity) => (
        activity.state === "running" ? { ...activity, state: "completed", outcome: "completed" } : activity
      )));
      setStatus("awaiting_approval");
    }
    if (event.type === "approval.decided" && isActive) {
      setApprovals((current) => current.map((item) => (
        item.id === event.approvalId
          ? { ...item, state: "responding", decision: event.decision }
          : item
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
          // The server settles the approval transaction before emitting the
          // terminal run event. Reflect that durable decision immediately;
          // waiting for the fetch body to close can otherwise leave a valid
          // approval visually stuck in "applying" after the answer is done.
          setApprovals((current) => current.map((item) => (
            item.runId === event.runId
              && item.state === "responding"
              && (item.decision === "approved" || item.decision === "rejected")
              ? { ...item, state: item.decision }
              : item
          )));
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
      if (scope) setThreads((current) => current.map((thread) => thread.id === scope.threadId ? { ...thread, status: "failed" } : thread));
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
        setError(event.error);
        setStatus("error");
        setRunId(null);
      }
      runScopesRef.current.delete(event.runId);
    }
  }, [resourceId, resourceType]);

  useEffect(() => {
    if (
      status !== "streaming"
      || !runId
      || !activeThreadId
      || !activeBranchId
      || streamControllersRef.current.has(activeThreadId)
    ) return undefined;
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const presentation = await agentApi.getLatestActivity(activeThreadId, activeBranchId);
        if (cancelled || presentation.run?.id !== runId) return;
        setActivities(activitiesFromEvents(
          presentation.events ?? [],
          presentation.run?.status,
        ));
        setQueuedInputs(queuedInputsFromEvents(
          presentation.events ?? [],
          presentation.run?.status,
        ));
        setSources(sourcesFromEvents(presentation.events ?? []));
        const runStatus = presentation.run.status;
        if (runStatus === "running" || runStatus === "queued") {
          const records = await agentApi.listMessages(activeThreadId, activeBranchId);
          if (cancelled) return;
          setMessages(records);
          setSources(dedupeAgentSources([
            ...sourcesFromEvents(presentation.events ?? []),
            ...latestAssistantSources(records),
          ]));
          timer = window.setTimeout(poll, 1_000);
          return;
        }
        const loaded = await loadMessages(activeThreadId, activeBranchId);
        if (cancelled) return;
        const threadRecords = await agentApi.listThreads(resourceScope);
        if (cancelled) return;
        threadsRef.current = threadRecords;
        setThreads(threadRecords);
        setRunId(null);
        runScopesRef.current.delete(runId);
        const pending = activeApprovalFrom(loaded?.approvals ?? []);
        if (pending) {
          setStatus(pending.state === "responding" ? "streaming" : "awaiting_approval");
        } else if (runStatus === "failed") {
          setError(presentation.run.error ?? "agent_run_failed");
          setStatus("error");
        } else {
          setError(null);
          setStatus(runtimeRef.current?.agent ? "ready" : "unconfigured");
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 1_500);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeBranchId, activeThreadId, loadMessages, resourceScope, runId, status]);

  const send = useCallback(async (message = draft, options = {}) => {
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
      await consumeAgentStream(`/api/agent/threads/${requestScope.threadId}/runs`, {
        branchId: requestScope.branchId,
        message: prompt,
        activeSectionId: requestSectionId,
        activeUnitId: resourceType === "semester_framework" ? activeUnitId || undefined : undefined,
        documentVersion: requestResourceVersion,
        selection: resourceType === "lesson_file" ? requestSelection || undefined : undefined,
        attachmentIds: attachmentSnapshot.map((attachment) => attachment.id),
        continuation,
      }, (event) => handleEvent(event, requestScope), { signal: controller.signal });
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
          const presentation = await agentApi.getLatestActivity(requestScope.threadId, requestScope.branchId);
          const persistedRun = presentation.run;
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
            await loadMessages(requestScope.threadId, requestScope.branchId, { preservePresentation: true });
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
      }
      try {
        const branchRecords = await agentApi.listBranches(requestScope.threadId);
        if (activeThreadRef.current === requestScope.threadId) setBranches(branchRecords);
      } catch {
        // The optimistic theme choice remains hidden; the next branch hydration
        // reconciles the server-owned interaction without reviving stale UI.
      }
    }
  }, [activeBranchId, activeSectionId, activeThreadId, activeUnitId, draft, handleEvent, loadMessages, onBeforeRun, pendingInteraction, queueDelivery, replaceUploads, resourceScope, resourceType, runId, runtime?.agent, selection, setDraft, uploads]);

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
    if (!approval) return;
    try {
      const flushed = await onBeforeRun?.();
      const flushedVersion = resourceType === "semester_framework"
        ? flushed?.framework?.version ?? flushed?.frameworkVersion
        : flushed?.documentVersion;
      if (flushedVersion !== undefined) {
        resourceVersionRef.current = flushedVersion;
      }
    } catch {
      setError("document_save_failed");
      setStatus("awaiting_approval");
      return;
    }
    setError(null);
    setApprovals((current) => current.map((item) => (
      item.id === approval.id
        ? { ...item, state: "responding", decision: approved ? "approved" : "rejected" }
        : item
    )));
    setStatus("streaming");
    const idempotencyKey = crypto.randomUUID();
    const requestScope = {
      threadId: activeThreadRef.current,
      branchId: activeBranchRef.current,
    };
    let decisionCommitted = approval.state === "continuation";
    let terminalError = null;
    try {
      await consumeAgentStream(
        `/api/agent/runs/${approval.runId}/approvals/${approval.id}`,
        { approved },
        (event) => {
          if (event.type === "run.failed") terminalError = event.error;
          if (event.type === "approval.decided") decisionCommitted = true;
          if (event.type === "run.started") {
            setApprovals((current) => current.map((item) => (
              item.id === approval.id
                ? {
                    ...item,
                    state: "responding",
                    decision: approved ? "approved" : "rejected",
                  }
                : item
            )));
          }
          handleEvent(event, requestScope);
        },
        { idempotencyKey },
      );
      if (terminalError) throw new Error(terminalError);
      if (requestScope.threadId && requestScope.branchId) {
        const loaded = await loadMessages(requestScope.threadId, requestScope.branchId);
        applyBranchPresentation(requestScope.threadId, requestScope.branchId, loaded);
        const records = await agentApi.listThreads(resourceScope);
        threadsRef.current = records;
        setThreads(records);
      }
    } catch (approvalError) {
      const effectiveError = terminalError ?? approvalError.message;
      const retryableDecision = canRetryApprovalDecision(effectiveError);
      const continuationReady = decisionCommitted && retryableDecision;
      // The approval transaction is authoritative even when the following Pi
      // continuation fails or its stream disconnects. Rehydrate the committed
      // resource instead of relying on an earlier SSE event having reached the
      // browser; this also makes an idempotent continuation retry UI-only.
      if (decisionCommitted && approved) {
        try {
          if (resourceType === "semester_framework") {
            const canonical = await agentApi.getSemesterFramework(resourceId);
            const version = canonical?.framework?.version ?? canonical?.frameworkVersion;
            if (version !== undefined) resourceVersionRef.current = version;
            onCanonicalFrameworkRef.current?.(canonical);
          } else {
            const canonical = await agentApi.getLessonFile(resourceId);
            if (canonical?.documentVersion !== undefined) {
              resourceVersionRef.current = canonical.documentVersion;
            }
            onCanonicalDocumentRef.current?.(canonical);
          }
        } catch {
          // The durable approval remains recoverable. Branch hydration below
          // keeps the continuation card available until a later refresh.
        }
      }
      setError(continuationReady ? null : effectiveError);
      setStatus(continuationReady ? "awaiting_approval" : "error");
      setApprovals((current) => current.map((item) => {
        if (item.id !== approval.id) return item;
        if (!retryableDecision) {
          return { ...item, state: "expired" };
        }
        return {
          ...item,
          state: decisionCommitted ? "continuation" : "pending",
          decision: decisionCommitted ? (approved ? "approved" : "rejected") : null,
        };
      }));
    }
  }, [approval, applyBranchPresentation, handleEvent, loadMessages, onBeforeRun, resourceId, resourceScope, resourceType]);

  const switchBranch = useCallback(async (branchId) => {
    if (!activeThreadId) return;
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
    activities, queuedInputs, queueDelivery, sources, approvals, approval, pendingInteraction, status, error, uploadError, runId, draft, uploads,
    startersLoading, startersError,
    setDraft, setQueueDelivery, send, retry, stop, clearQueuedInputs, respondApproval, selectThread, switchBranch, createThread, branchFromMessage,
    updateActiveThread, removeActiveThread, uploadKnowledge, dismissUpload, retryUpload, retryStarters,
  };
}
