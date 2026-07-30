import { useCallback, useEffect, useRef, useState } from "react";

import { agentApi, consumeAgentStream } from "@/lib/agent-api";
import {
  lastRetryableUserMessage,
  resetAgentConversationState,
  resolveBranchSourceMessage,
  stopAgentRun,
  synchronizeCompletedAgentTurn,
} from "./agent-run-control.js";

const draftKey = (threadId) => `lessonup:agent-draft:${threadId ?? "new"}`;

export function useAgentChat({
  notebookId,
  lessonFileId,
  activeSectionId,
  selection,
  onPatchApplied,
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
  const [approval, setApproval] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [runId, setRunId] = useState(null);
  const [draft, setDraftState] = useState("");
  const [uploads, setUploads] = useState([]);
  const [storageRevision, setStorageRevision] = useState(0);
  const appliedApprovalRef = useRef(new Set());
  const activeThreadRef = useRef(null);
  const activeBranchRef = useRef(null);
  const threadsRef = useRef([]);
  const runtimeRef = useRef(null);
  const runScopesRef = useRef(new Map());
  const streamControllersRef = useRef(new Map());

  useEffect(() => { activeThreadRef.current = activeThreadId; }, [activeThreadId]);
  useEffect(() => { activeBranchRef.current = activeBranchId; }, [activeBranchId]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  useEffect(() => { runtimeRef.current = runtime; }, [runtime]);

  useEffect(() => {
    const handleStorageReady = () => setStorageRevision((revision) => revision + 1);
    window.addEventListener("lessonup:agent-storage-ready", handleStorageReady);
    return () => window.removeEventListener("lessonup:agent-storage-ready", handleStorageReady);
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
      setUploads((current) => current.map((upload) => byId.get(upload.id) ?? upload));
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [uploads]);

  useEffect(() => {
    if (approval?.state === "pending") setStatus("awaiting_approval");
  }, [approval?.state]);

  const setDraft = useCallback((value) => {
    setDraftState(value);
    window.localStorage.setItem(draftKey(activeThreadId), value);
  }, [activeThreadId]);

  const loadMessages = useCallback(async (threadId, branchId, { preservePresentation = false } = {}) => {
    const [records, approvals] = await Promise.all([
      agentApi.listMessages(threadId, branchId),
      agentApi.listPendingApprovals(threadId, branchId),
    ]);
    setMessages(records);
    if (!preservePresentation) setActivities([]);
    setSources(records.flatMap((message) => message.sources ?? []));
    const pending = approvals[0];
    setApproval(pending ? { id: pending.id, runId: pending.runId, patch: pending.patch, state: "pending" } : null);
  }, []);

  const selectThread = useCallback(async (threadId) => {
    setActiveThreadId(threadId);
    const records = await agentApi.listBranches(threadId);
    setBranches(records);
    const branchId = records.at(-1)?.id;
    setActiveBranchId(branchId ?? null);
    setDraftState(window.localStorage.getItem(draftKey(threadId)) ?? "");
    if (branchId) await loadMessages(threadId, branchId);
    const selected = threadsRef.current.find((thread) => thread.id === threadId);
    const activeRun = [...runScopesRef.current.entries()].find(([, scope]) => scope.threadId === threadId);
    const hasLocalStream = Boolean(activeRun && streamControllersRef.current.has(threadId));
    setRunId(hasLocalStream ? activeRun?.[0] ?? null : null);
    setError(selected?.status === "running" && !hasLocalStream
      ? "run_interrupted"
      : selected?.status === "failed" ? "上一轮运行失败，可以重试。" : null);
    setStatus(selected?.status === "running" && hasLocalStream ? "streaming"
      : selected?.status === "awaiting_approval" ? "awaiting_approval"
        : selected?.status === "failed" || (selected?.status === "running" && !hasLocalStream) ? "error"
          : runtimeRef.current?.agent ? "ready" : "unconfigured");
  }, [loadMessages]);

  const createThread = useCallback(async () => {
    const result = await agentApi.createThread({ notebookId, lessonFileId });
    setThreads((current) => [result.thread, ...current]);
    setActiveThreadId(result.thread.id);
    setBranches([result.branch]);
    setActiveBranchId(result.branch.id);
    setMessages([]);
    setActivities([]);
    setSources([]);
    setDraftState("");
    resetAgentConversationState({ runtime: runtimeRef.current, setApproval, setError, setRunId, setStatus });
    return result;
  }, [lessonFileId, notebookId]);

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
    else await createThread();
  }, [activeThreadId, createThread, lessonFileId, selectThread]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setStatus("loading");
      setError(null);
      try {
        const nextRuntime = await agentApi.runtime();
        if (cancelled) return;
        setRuntime(nextRuntime);
        const records = await agentApi.listThreads(lessonFileId);
        if (cancelled) return;
        setThreads(records);
        if (records[0]) await selectThread(records[0].id);
        else await createThread();
        if (!cancelled) setStatus(nextRuntime.agent ? "ready" : "unconfigured");
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
  }, [createThread, lessonFileId, selectThread, storageRevision]);

  const handleEvent = useCallback((event) => {
    if (event.type === "run.started") {
      runScopesRef.current.set(event.runId, { threadId: event.threadId, branchId: event.branchId });
      setThreads((current) => current.map((thread) => thread.id === event.threadId ? { ...thread, status: "running" } : thread));
      const isActive = activeThreadRef.current === event.threadId && activeBranchRef.current === event.branchId;
      if (!isActive) return;
      setRunId(event.runId);
      setStatus("streaming");
      setMessages((current) => current.some((message) => message.status === "streaming")
        ? current
        : [...current, { id: `stream-${event.runId}`, role: "assistant", content: "", status: "streaming" }]);
    }
    const scope = runScopesRef.current.get(event.runId);
    const isActive = scope
      ? activeThreadRef.current === scope.threadId && activeBranchRef.current === scope.branchId
      : event.runId === "unknown";
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
      setSources((current) => current.some((source) => source.id === event.source.id) ? current : [...current, event.source]);
    }
    if (event.type === "approval.required") {
      if (scope) setThreads((current) => current.map((thread) => thread.id === scope.threadId ? { ...thread, status: "awaiting_approval" } : thread));
      if (!isActive) return;
      setApproval({ id: event.approvalId, runId: event.runId, patch: event.patch, state: "pending" });
      setStatus("awaiting_approval");
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
        setStatus("ready");
        setRunId(null);
      }
      runScopesRef.current.delete(event.runId);
    }
    if (event.type === "run.failed") {
      if (scope) setThreads((current) => current.map((thread) => thread.id === scope.threadId ? { ...thread, status: "failed" } : thread));
      if (isActive) {
        setError(event.error);
        setStatus("error");
        setRunId(null);
      }
      runScopesRef.current.delete(event.runId);
    }
  }, []);

  const send = useCallback(async (message = draft) => {
    const prompt = message.trim();
    if (!prompt || !activeThreadId || !activeBranchId || !runtime?.agent) return;
    try {
      await onBeforeRun?.();
    } catch {
      setError("document_save_failed");
      setStatus("error");
      return;
    }
    setDraft("");
    setError(null);
    setActivities([]);
    setSources([]);
    setApproval(null);
    setMessages((current) => [...current, {
      id: `optimistic-${crypto.randomUUID()}`, role: "user", content: prompt, status: "completed",
    }]);
    const controller = new AbortController();
    streamControllersRef.current.set(activeThreadId, controller);
    try {
      await consumeAgentStream(`/api/agent/threads/${activeThreadId}/runs`, {
        branchId: activeBranchId,
        message: prompt,
        activeSectionId,
        selection: selection || undefined,
      }, handleEvent, { signal: controller.signal });
      const records = await synchronizeCompletedAgentTurn({
        threadId: activeThreadId,
        branchId: activeBranchId,
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
        setError(streamError.message);
        setStatus("error");
      }
    } finally {
      if (streamControllersRef.current.get(activeThreadId) === controller) {
        streamControllersRef.current.delete(activeThreadId);
      }
    }
  }, [activeBranchId, activeSectionId, activeThreadId, draft, handleEvent, lessonFileId, loadMessages, onBeforeRun, runtime?.agent, selection, setDraft]);

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
    setApproval((current) => ({ ...current, state: "responding" }));
    const idempotencyKey = crypto.randomUUID();
    let applied = false;
    let terminalError = null;
    try {
      await consumeAgentStream(
        `/api/agent/runs/${approval.runId}/approvals/${approval.id}`,
        { approved },
        (event) => {
          if (event.type === "run.failed") terminalError = event.error;
          if (approved && event.type === "run.started" && !appliedApprovalRef.current.has(approval.id)) {
            appliedApprovalRef.current.add(approval.id);
            applied = true;
            onPatchApplied(approval.patch);
          }
          handleEvent(event);
        },
        { idempotencyKey },
      );
      if (terminalError) throw new Error(terminalError);
      setApproval((current) => current ? { ...current, state: approved ? "approved" : "rejected" } : null);
    } catch (approvalError) {
      if (applied) appliedApprovalRef.current.delete(approval.id);
      setError(approvalError.message);
      setStatus("error");
      setApproval((current) => current ? { ...current, state: "pending" } : null);
    }
  }, [approval, handleEvent, onPatchApplied]);

  const switchBranch = useCallback(async (branchId) => {
    setActiveBranchId(branchId);
    await loadMessages(activeThreadId, branchId);
  }, [activeThreadId, loadMessages]);

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
    setActiveBranchId(branch.id);
    await loadMessages(activeThreadId, branch.id);
    if (editedContent !== undefined) setDraft(editedContent);
  }, [activeBranchId, activeThreadId, loadMessages, setDraft]);

  const retry = useCallback(() => {
    const message = lastRetryableUserMessage(messages);
    return message ? send(message.content) : Promise.resolve();
  }, [messages, send]);

  const uploadKnowledge = useCallback(async (file) => {
    setError(null);
    try {
      const source = await agentApi.uploadKnowledge(file, { notebookId, lessonFileId });
      setUploads((current) => [...current, source]);
      return source;
    } catch (uploadError) {
      setError(uploadError.message);
      throw uploadError;
    }
  }, [lessonFileId, notebookId]);

  const dismissUpload = useCallback((sourceId) => {
    setUploads((current) => current.filter((upload) => upload.id !== sourceId));
  }, []);

  return {
    runtime, threads, activeThreadId, branches, activeBranchId, messages,
    activities, sources, approval, status, error, runId, draft, uploads,
    setDraft, send, retry, stop, respondApproval, selectThread, switchBranch, createThread, branchFromMessage,
    updateActiveThread, removeActiveThread, uploadKnowledge, dismissUpload,
  };
}
