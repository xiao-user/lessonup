// @ts-check
import { getAccessToken } from "./supabase.js";

const jsonHeaders = { "content-type": "application/json" };

/** @returns {Promise<Record<string, string>>} */
async function authHeaders() {
  const token = await getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * @template T
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<T>}
 */
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
  return /** @type {Promise<T>} */ (response.status === 204
    ? Promise.resolve(null)
    : response.json());
}

/** @type {Record<string, (...args: any[]) => Promise<any>>} */
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
  listSemesterFrameworks: (notebookId) => request(
    `/api/notebooks/${encodeURIComponent(notebookId)}/semester-frameworks`,
  ),
  createSemesterFramework: (
    notebookId,
    input,
    idempotencyKey = crypto.randomUUID(),
  ) => request(
    `/api/notebooks/${encodeURIComponent(notebookId)}/semester-frameworks`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    },
  ),
  getSemesterFramework: (frameworkId) => request(
    `/api/semester-frameworks/${encodeURIComponent(frameworkId)}`,
  ),
  updateSemesterFramework: (frameworkId, input, idempotencyKey = crypto.randomUUID()) => request(
    `/api/semester-frameworks/${encodeURIComponent(frameworkId)}`,
    {
      method: "PATCH",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    },
  ),
  createLessonBlueprint: (frameworkId, input, idempotencyKey = crypto.randomUUID()) => request(
    `/api/semester-frameworks/${encodeURIComponent(frameworkId)}/blueprints`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    },
  ),
  updateLessonBlueprint: (
    frameworkId,
    blueprintId,
    input,
    idempotencyKey = crypto.randomUUID(),
  ) => request(
    `/api/semester-frameworks/${encodeURIComponent(frameworkId)}`
      + `/blueprints/${encodeURIComponent(blueprintId)}`,
    {
      method: "PATCH",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    },
  ),
  deleteLessonBlueprint: (
    frameworkId,
    blueprintId,
    input,
    idempotencyKey = crypto.randomUUID(),
  ) => request(
    `/api/semester-frameworks/${encodeURIComponent(frameworkId)}`
      + `/blueprints/${encodeURIComponent(blueprintId)}`,
    {
      method: "DELETE",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    },
  ),
  getSemesterFrameworkContinuity: (frameworkId) => request(
    `/api/semester-frameworks/${encodeURIComponent(frameworkId)}/continuity`,
  ),
  refreshSemesterFrameworkContinuity: (frameworkId) => request(
    `/api/semester-frameworks/${encodeURIComponent(frameworkId)}/continuity/refresh`,
    { method: "POST" },
  ),
  setSemesterFrameworkContinuityDecision: (frameworkId, input) => request(
    `/api/semester-frameworks/${encodeURIComponent(frameworkId)}/continuity/decisions`,
    { method: "POST", body: JSON.stringify(input) },
  ),
  listLessonClassFeedback: (lessonFileId) => request(
    `/api/lesson-files/${encodeURIComponent(lessonFileId)}/class-feedback`,
  ),
  createLessonClassFeedback: (lessonFileId, input) => request(
    `/api/lesson-files/${encodeURIComponent(lessonFileId)}/class-feedback`,
    { method: "POST", body: JSON.stringify(input) },
  ),
  listFrameworkClassFeedback: (frameworkId) => request(
    `/api/semester-frameworks/${encodeURIComponent(frameworkId)}/class-feedback`,
  ),
  createLessonFile: (input, idempotencyKey = crypto.randomUUID()) => request("/api/lesson-files", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(input),
  }),
  updateLessonFile: (fileId, input) => request(
    `/api/lesson-files/${encodeURIComponent(fileId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  ),
  listCurriculumFacets: () => request("/api/curriculum/facets"),
  getCurrentCurriculumCatalogRelease: () => request(
    "/api/curriculum/catalog/releases/current",
  ),
  getCurriculumCatalogRelease: (releaseId) => request(
    `/api/curriculum/catalog/releases/${encodeURIComponent(releaseId)}`,
  ),
  getCurriculumReleaseTextbook: (releaseId, textbookId) => request(
    `/api/curriculum/catalog/releases/${encodeURIComponent(releaseId)}`
      + `/textbooks/${encodeURIComponent(textbookId)}`,
  ),
  listCurriculumReleaseNodes: (releaseId, textbookId, filter = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value != null && value !== "") params.set(key, String(value));
    }
    const query = params.toString();
    return request(
      `/api/curriculum/catalog/releases/${encodeURIComponent(releaseId)}`
        + `/textbooks/${encodeURIComponent(textbookId)}/nodes${query ? `?${query}` : ""}`,
    );
  },
  listCurriculumTextbooks: (filter = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value != null && value !== "") params.set(key, String(value));
    }
    const query = params.toString();
    return request(`/api/curriculum/textbooks${query ? `?${query}` : ""}`);
  },
  getCurriculumTextbook: (textbookId) => request(
    `/api/curriculum/textbooks/${encodeURIComponent(textbookId)}`,
  ),
  listCurriculumNodes: (textbookId, filter = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value != null && value !== "") params.set(key, String(value));
    }
    const query = params.toString();
    return request(`/api/curriculum/textbooks/${encodeURIComponent(textbookId)}/nodes${query ? `?${query}` : ""}`);
  },
  readCurriculumNodeSemantics: (textbookId, nodeId) => request(
    `/api/curriculum/textbooks/${encodeURIComponent(textbookId)}/nodes/${encodeURIComponent(nodeId)}/semantics`,
  ),
  readCurriculumKnowledgePoints: (textbookId, nodeId) => request(
    `/api/curriculum/textbooks/${encodeURIComponent(textbookId)}/nodes/${encodeURIComponent(nodeId)}/knowledge-points`,
  ),
  readCurriculumKnowledgePointsBatch: (textbookId, nodeIds) => request(
    `/api/curriculum/textbooks/${encodeURIComponent(textbookId)}/knowledge-points/batch`,
    { method: "POST", body: JSON.stringify({ nodeIds }) },
  ),
  searchCurriculumKnowledgePoints: (textbookId, query, limit = 12) => {
    const params = new URLSearchParams({ query: String(query), limit: String(limit) });
    return request(`/api/curriculum/textbooks/${encodeURIComponent(textbookId)}/knowledge-points?${params}`);
  },
  readCurriculumKnowledgeContinuity: (textbookId, entityId, currentNodeId, limit = 12) => {
    const params = new URLSearchParams({ currentNodeId: String(currentNodeId), limit: String(limit) });
    return request(`/api/curriculum/textbooks/${encodeURIComponent(textbookId)}/knowledge-points/${encodeURIComponent(entityId)}/continuity?${params}`);
  },
  getCurriculumSemanticEntity: (entityId) => request(
    `/api/curriculum/semantics/${encodeURIComponent(entityId)}`,
  ),
  traceCurriculumLearningPath: (entityId, filter = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value == null || value === "") continue;
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    const query = params.toString();
    return request(`/api/curriculum/semantics/${encodeURIComponent(entityId)}/path${query ? `?${query}` : ""}`);
  },
  deleteLessonFile: (fileId) => request(
    `/api/lesson-files/${encodeURIComponent(fileId)}`,
    { method: "DELETE" },
  ),
  importNotebooks: (notebooks) => request("/api/bootstrap/import", {
    method: "POST", body: JSON.stringify({ notebooks }),
  }),
  getLessonFile: (fileId) => request(`/api/lesson-files/${encodeURIComponent(fileId)}`),
  getLessonDesignBasis: (fileId) => request(
    `/api/lesson-files/${encodeURIComponent(fileId)}/design-basis`,
  ),
  updateLessonDesignBasis: (fileId, input, idempotencyKey = crypto.randomUUID()) => request(
    `/api/lesson-files/${encodeURIComponent(fileId)}/design-basis`,
    { method: "PATCH", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(input) },
  ),
  saveLessonDocument: (fileId, input, idempotencyKey = crypto.randomUUID()) => request(
    `/api/lesson-files/${encodeURIComponent(fileId)}/document`,
    { method: "PATCH", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(input) },
  ),
  updateLessonPageCount: (fileId, input) => request(
    `/api/lesson-files/${encodeURIComponent(fileId)}/page-count`,
    { method: "PATCH", body: JSON.stringify(input) },
  ),
  listThreads: (resource) => {
    const scope = typeof resource === "string" ? { lessonFileId: resource } : resource;
    const params = new URLSearchParams();
    if (scope.lessonFileId) params.set("lessonFileId", scope.lessonFileId);
    if (scope.semesterFrameworkId) {
      params.set("semesterFrameworkId", scope.semesterFrameworkId);
    }
    return request(`/api/agent/threads?${params}`);
  },
  createThread: (input, idempotencyKey = crypto.randomUUID()) => request("/api/agent/threads", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(input),
  }),
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
  listKnowledgeUploads: (scope = {}) => {
    const query = new URLSearchParams();
    if (scope.notebookId) query.set("notebookId", scope.notebookId);
    if (scope.lessonFileId) query.set("lessonFileId", scope.lessonFileId);
    if (scope.includeAttached) query.set("view", "all");
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

/**
 * @param {string} path
 * @param {unknown} input
 * @param {(event: any, eventName: string) => void} onEvent
 * @param {{ signal?: AbortSignal, idempotencyKey?: string }} [options]
 */
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
  /** @type {string[]} */
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
