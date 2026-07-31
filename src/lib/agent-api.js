import { getAccessToken } from "@/lib/supabase";

const jsonHeaders = { "content-type": "application/json" };

async function authHeaders() {
  const token = await getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request(path, options = {}) {
  const usesFormData = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: { ...await authHeaders(), ...(options.body && !usesFormData ? jsonHeaders : {}), ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `request_failed:${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

export const agentApi = {
  runtime: () => request("/api/runtime"),
  listNotebooks: () => request("/api/notebooks"),
  createNotebook: (input) => request("/api/notebooks", { method: "POST", body: JSON.stringify(input) }),
  updateNotebook: (notebookId, input) => request(
    `/api/notebooks/${encodeURIComponent(notebookId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  ),
  deleteNotebook: (notebookId) => request(
    `/api/notebooks/${encodeURIComponent(notebookId)}`,
    { method: "DELETE" },
  ),
  createLessonFile: (input) => request("/api/lesson-files", { method: "POST", body: JSON.stringify(input) }),
  updateLessonFile: (fileId, input) => request(
    `/api/lesson-files/${encodeURIComponent(fileId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  ),
  deleteLessonFile: (fileId) => request(
    `/api/lesson-files/${encodeURIComponent(fileId)}`,
    { method: "DELETE" },
  ),
  importNotebooks: (notebooks) => request("/api/bootstrap/import", {
    method: "POST", body: JSON.stringify({ notebooks }),
  }),
  getLessonFile: (fileId) => request(`/api/lesson-files/${encodeURIComponent(fileId)}`),
  saveLessonDocument: (fileId, input, idempotencyKey = crypto.randomUUID()) => request(
    `/api/lesson-files/${encodeURIComponent(fileId)}/document`,
    { method: "PATCH", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(input) },
  ),
  listThreads: (lessonFileId) => request(`/api/agent/threads?lessonFileId=${encodeURIComponent(lessonFileId)}`),
  createThread: (input) => request("/api/agent/threads", { method: "POST", body: JSON.stringify(input) }),
  generateThreadStarters: (threadId) => request(
    `/api/agent/threads/${threadId}/starters`,
    { method: "POST", body: JSON.stringify({}) },
  ),
  updateThread: (threadId, input) => request(`/api/agent/threads/${threadId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteThread: (threadId) => request(`/api/agent/threads/${threadId}`, { method: "DELETE" }),
  listBranches: (threadId) => request(`/api/agent/threads/${threadId}/branches`),
  listMessages: (threadId, branchId) => request(`/api/agent/threads/${threadId}/messages?branchId=${branchId}`),
  listApprovals: (threadId, branchId) => request(`/api/agent/threads/${threadId}/approvals?branchId=${branchId}`),
  getLatestActivity: (threadId, branchId) => request(`/api/agent/threads/${threadId}/activity?branchId=${branchId}`),
  createBranch: (messageId, input) => request(`/api/agent/messages/${messageId}/branch`, { method: "POST", body: JSON.stringify(input) }),
  cancelRun: (runId) => request(`/api/agent/runs/${runId}/cancel`, { method: "POST", body: JSON.stringify({}) }),
  uploadKnowledge: (file, scope, idempotencyKey = crypto.randomUUID()) => {
    const body = new FormData();
    body.append("file", file);
    if (scope.notebookId) body.append("notebookId", scope.notebookId);
    if (scope.lessonFileId) body.append("lessonFileId", scope.lessonFileId);
    return request("/api/knowledge/uploads", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body,
    });
  },
  listKnowledgeUploads: (scope) => {
    const query = new URLSearchParams();
    if (scope.notebookId) query.set("notebookId", scope.notebookId);
    if (scope.lessonFileId) query.set("lessonFileId", scope.lessonFileId);
    return request(`/api/knowledge/uploads?${query}`);
  },
  getKnowledgeUpload: (sourceId) => request(`/api/knowledge/uploads/${sourceId}`),
  retryKnowledgeUpload: (sourceId) => request(`/api/knowledge/uploads/${sourceId}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  deleteKnowledgeUpload: (sourceId) => request(`/api/knowledge/uploads/${sourceId}`, {
    method: "DELETE",
  }),
};

export async function consumeAgentStream(path, input, onEvent, options = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...await authHeaders(),
      ...jsonHeaders,
      accept: "text/event-stream",
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    body: JSON.stringify(input),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `stream_failed:${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  const flush = () => {
    if (!dataLines.length) return;
    const raw = dataLines.join("\n");
    dataLines = [];
    try {
      onEvent(JSON.parse(raw), eventName);
    } finally {
      eventName = "message";
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) { flush(); continue; }
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (done) break;
  }
  if (buffer) {
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
  }
  flush();
}
