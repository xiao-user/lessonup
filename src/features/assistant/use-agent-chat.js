import { useCallback, useEffect, useRef, useState } from "react";

import { agentApi, consumeAgentStream } from "@/lib/agent-api";
import {
  activitiesFromEvents,
  canRetryApprovalDecision,
  deriveBranchRuntimeState,
  lastRetryableUserMessage,
  resetAgentConversationState,
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
    item.state === "pending"
    || item.state === "responding"
    || item.state === "continuation"
  )) ?? null;
}

export function useAgentChat({
  notebookId,
  lessonFileId,
  documentVersion,
  activeSectionId,
  selection,
  onCanonicalDocument,
  onBeforeRun,
}) {
  const [runtime, setRuntime] = useState(null);
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [branches, setBranches] = useState([]);
  const [activeBranchId, setActiveBranchId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activities, setActivities] = useState([]);
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
  const documentVersionRef = useRef(documentVersion);
  const activeThreadRef = useRef(null);
  const activeBranchRef = useRef(null);
  const threadsRef = useRef([]);
  const runtimeRef = useRef(null);
  const messagesRef = useRef([]);
  const runScopesRef = useRef(new Map());
  const streamControllersRef = useRef(new Map());
  const starterRequestsRef = useRef(new Set());
  const approval = activeApprovalFrom(approvals);
  documentVersionRef.current = documentVersion;

  useEffect(() => { activeThreadRef.current = activeThreadId; }, [activeThreadId]);
  useEffect(() => { activeBranchRef.current = activeBranchId; }, [activeBranchId]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  useEffect(() => { runtimeRef.current = runtime; }, [runtime]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

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
      setUploads((current) => current.map((upload) => byId.get(upload.id) ?? upload));
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [uploads]);

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
    }
    setSources(latestAssistantSources(records));
    const presentedApprovals = approvalRecords.map(presentApproval);
    setApprovals(presentedApprovals);
    if (presentedApprovals.some((item) => item.state === "approved")) {
      const file = await agentApi.getLessonFile(lessonFileId);
      if (file.documentVersion > documentVersionRef.current) {
        documentVersionRef.current = file.documentVersion;
        onCanonicalDocument(file);
      }
    }
    return { records, approvals: presentedApprovals, presentation };
  }, [lessonFileId, onCanonicalDocument]);

  const ensureThreadStarters = useCallback(async (thread, hasMessages, { force = false } = {}) => {
    if (
      !thread
      || hasMessages
      || (!force && (
        thread.starterSuggestions?.length
        && thread.starterSuggestionsDocumentVersion === documentVersionRef.current
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
  }, []);

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
    activeThreadRef.current = threadId;
    setActiveThreadId(threadId);
    setApprovals([]);
    setUploads([]);
    setUploadError(null);
    setStartersLoading(false);
    setStartersError(null);
    setActivities([]);
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
  }, [applyBranchPresentation, ensureThreadStarters, loadMessages]);

  const createThread = useCallback(async (force = false) => {
    if (
      force !== true
      && activeThreadRef.current
      && messagesRef.current.length === 0
    ) {
      return { created: false, reason: "current_thread_empty" };
    }
    setStatus("loading");
    setError(null);
    let result;
    try {
      result = await agentApi.createThread({
        notebookId,
        lessonFileId,
        currentThreadId: force === true ? undefined : activeThreadRef.current ?? undefined,
        currentBranchId: force === true ? undefined : activeBranchRef.current ?? undefined,
      });
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
    setSources([]);
    setDraftState("");
    setUploads([]);
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
  }, [ensureThreadStarters, lessonFileId, notebookId]);

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
    const records = await agentApi.listThreads(lessonFileId);
    setThreads(records);
    if (records[0]) await selectThread(records[0].id);
    else await createThread(true);
  }, [activeThreadId, createThread, lessonFileId, selectThread]);

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
        const records = await agentApi.listThreads(lessonFileId);
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
  }, [createThread, lessonFileId, selectThread]);

  const handleEvent = useCallback((event, explicitScope = null) => {
    if (event.type === "run.started") {
      runScopesRef.current.set(event.runId, { threadId: event.threadId, branchId: event.branchId });
      setThreads((current) => current.map((thread) => thread.id === event.threadId ? { ...thread, status: "running" } : thread));
      const isActive = activeThreadRef.current === event.threadId && activeBranchRef.current === event.branchId;
      if (!isActive) return;
      setRunId(event.runId);
      setStatus("streaming");
      setSources([]);
      setMessages((current) => current.some((message) => message.status === "streaming")
        ? current
        : [...current, { id: `stream-${event.runId}`, role: "assistant", content: "", status: "streaming" }]);
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
    if (event.type === "document.updated") {
      if (
        event.file.id === lessonFileId
        && event.file.documentVersion > documentVersionRef.current
      ) {
        documentVersionRef.current = event.file.documentVersion;
        onCanonicalDocument(event.file);
      }
    }
    if (event.type === "message.delta") {
      if (!isActive) return;
      setMessages((current) => {
        const index = current.findLastIndex((message) => message.role === "assistant" && message.status === "streaming");
        if (index < 0) return [...current, { id: `stream-${event.runId}`, role: "assistant", content: event.delta, status: "streaming" }];
        const next = [...current];
        next[index] = { ...next[index], content: `${next[index].content}${event.delta}` };
        return next;
      });
    }
    if (event.type === "tool.started") {
      if (!isActive) return;
      setActivities((current) => [...current, {
        id: event.toolCallId,
        name: event.name,
        label: event.label,
        groupKey: event.groupKey,
        state: "running",
      }]);
    }
    if (event.type === "tool.completed") {
      if (!isActive) return;
      setActivities((current) => current.map((activity) => activity.id === event.toolCallId
        ? {
          ...activity,
          state: event.ok ? "completed" : "failed",
          label: event.label,
          groupKey: event.groupKey ?? activity.groupKey,
        }
        : activity));
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
        const withoutStream = current.filter((message) => message.status !== "streaming");
        return withoutStream.some((message) => message.id === event.message.id)
          ? withoutStream.map((message) => message.id === event.message.id ? event.message : message)
          : [...withoutStream, event.message];
      });
    }
    if (event.type === "run.completed" || event.type === "run.cancelled") {
      if (scope) setThreads((current) => current.map((thread) => thread.id === scope.threadId ? { ...thread, status: "idle" } : thread));
      if (isActive) {
        if (event.type === "run.completed") {
          setActivities((current) => current.map((activity) => (
            activity.state === "running" ? { ...activity, state: "completed" } : activity
          )));
        }
        setStatus("ready");
        setRunId(null);
      }
      runScopesRef.current.delete(event.runId);
    }
    if (event.type === "run.failed") {
      if (scope) setThreads((current) => current.map((thread) => thread.id === scope.threadId ? { ...thread, status: "failed" } : thread));
      if (isActive) {
        setActivities((current) => current.map((activity) => (
          activity.state === "running" ? { ...activity, state: "failed" } : activity
        )));
        setMessages((current) => {
          const index = current.findLastIndex((message) => (
            message.role === "assistant" && message.status === "streaming"
          ));
          if (index < 0) return current;
          const next = [...current];
          next[index] = { ...next[index], status: "failed", error: event.error };
          return next;
        });
        setError(event.error);
        setStatus("error");
        setRunId(null);
      }
      runScopesRef.current.delete(event.runId);
    }
  }, [lessonFileId, onCanonicalDocument]);

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
        setSources(sourcesFromEvents(presentation.events ?? []));
        const runStatus = presentation.run.status;
        if (runStatus === "running" || runStatus === "queued") {
          timer = window.setTimeout(poll, 1_000);
          return;
        }
        const loaded = await loadMessages(activeThreadId, activeBranchId);
        if (cancelled) return;
        const threadRecords = await agentApi.listThreads(lessonFileId);
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
  }, [activeBranchId, activeThreadId, lessonFileId, loadMessages, runId, status]);

  const send = useCallback(async (message = draft) => {
    const attachmentSnapshot = readyUploadSources(uploads);
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
    const requestSectionId = activeSectionId;
    const requestSelection = selection;
    const controller = new AbortController();
    streamControllersRef.current.set(requestScope.threadId, controller);
    setDraft("");
    setUploads([]);
    setError(null);
    setActivities([]);
    setSources([]);
    setRunId(null);
    setStatus("streaming");
    setMessages((current) => [
      ...current,
      {
        id: optimisticUserId,
        role: "user",
        content: prompt,
        status: "completed",
        sources: attachmentSnapshot,
      },
      {
        id: optimisticAssistantId,
        role: "assistant",
        content: "",
        status: "streaming",
      },
    ]);
    let requestDocumentVersion;
    try {
      const flushed = await onBeforeRun?.();
      requestDocumentVersion = flushed?.documentVersion ?? documentVersionRef.current;
      documentVersionRef.current = requestDocumentVersion;
    } catch {
      setMessages((current) => current.filter((item) => (
        item.id !== optimisticUserId && item.id !== optimisticAssistantId
      )));
      setDraft(message);
      setUploads(uploadDraftSnapshot);
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
        documentVersion: requestDocumentVersion,
        selection: requestSelection || undefined,
        attachmentIds: attachmentSnapshot.map((attachment) => attachment.id),
      }, (event) => handleEvent(event, requestScope), { signal: controller.signal });
      const records = await synchronizeCompletedAgentTurn({
        threadId: requestScope.threadId,
        branchId: requestScope.branchId,
        loadMessages: (threadId, branchId) => loadMessages(
          threadId,
          branchId,
          { preservePresentation: true },
        ),
        listThreads: () => agentApi.listThreads(lessonFileId),
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
    }
  }, [activeBranchId, activeSectionId, activeThreadId, draft, handleEvent, lessonFileId, loadMessages, onBeforeRun, runtime?.agent, selection, setDraft, uploads]);

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
    const persistedThreads = await agentApi.listThreads(lessonFileId);
    threadsRef.current = persistedThreads;
    setThreads(persistedThreads);
  }, [activeBranchId, activeThreadId, loadMessages, runId, runtime?.agent]);

  const respondApproval = useCallback(async (approved) => {
    if (!approval) return;
    try {
      const flushed = await onBeforeRun?.();
      if (flushed?.documentVersion !== undefined) {
        documentVersionRef.current = flushed.documentVersion;
      }
    } catch {
      setError("document_save_failed");
      setStatus("awaiting_approval");
      return;
    }
    setError(null);
    setApprovals((current) => current.map((item) => (
      item.id === approval.id ? { ...item, state: "responding" } : item
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
      setApprovals((current) => current.map((item) => (
        item.id === approval.id
          ? { ...item, state: approved ? "approved" : "rejected" }
          : item
      )));
    } catch (approvalError) {
      const effectiveError = terminalError ?? approvalError.message;
      setError(effectiveError);
      setStatus("error");
      setApprovals((current) => current.map((item) => {
        if (item.id !== approval.id) return item;
        if (!canRetryApprovalDecision(effectiveError)) {
          return { ...item, state: "expired" };
        }
        return {
          ...item,
          state: decisionCommitted ? "continuation" : "pending",
          decision: decisionCommitted ? (approved ? "approved" : "rejected") : null,
        };
      }));
    }
  }, [approval, handleEvent, onBeforeRun]);

  const switchBranch = useCallback(async (branchId) => {
    if (!activeThreadId) return;
    activeBranchRef.current = branchId;
    setActiveBranchId(branchId);
    window.localStorage.setItem(branchKey(activeThreadId), branchId);
    setApprovals([]);
    setActivities([]);
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
    setDraft(message.content);
    setError(null);
    setStatus(runtimeRef.current?.agent ? "ready" : "unconfigured");
  }, [messages, setDraft]);

  const retryStarters = useCallback(() => {
    const thread = threadsRef.current.find((item) => item.id === activeThreadRef.current);
    if (!thread || messagesRef.current.length) return;
    void ensureThreadStarters(thread, false, { force: true });
  }, [ensureThreadStarters]);

  const uploadKnowledge = useCallback(async (file) => {
    setUploadError(null);
    try {
      const source = await agentApi.uploadKnowledge(file, { notebookId, lessonFileId });
      setUploads((current) => [...current, source]);
      return source;
    } catch (uploadError) {
      setUploadError(uploadError.message);
      throw uploadError;
    }
  }, [lessonFileId, notebookId]);

  const dismissUpload = useCallback(async (sourceId) => {
    await agentApi.deleteKnowledgeUpload(sourceId);
    setUploads((current) => current.filter((upload) => upload.id !== sourceId));
    setUploadError(null);
  }, []);

  const retryUpload = useCallback(async (sourceId) => {
    const source = await agentApi.retryKnowledgeUpload(sourceId);
    setUploads((current) => current.map((upload) => upload.id === sourceId ? source : upload));
    setUploadError(null);
  }, []);

  return {
    runtime, threads, activeThreadId, branches, activeBranchId, messages,
    activities, sources, approvals, approval, status, error, uploadError, runId, draft, uploads,
    startersLoading, startersError,
    setDraft, send, retry, stop, respondApproval, selectThread, switchBranch, createThread, branchFromMessage,
    updateActiveThread, removeActiveThread, uploadKnowledge, dismissUpload, retryUpload, retryStarters,
  };
}
