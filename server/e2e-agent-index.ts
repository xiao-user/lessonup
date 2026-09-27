import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { createRepository } from "./repositories/index.js";
import { DeterministicAgentHarness } from "./testing/deterministic-agent-harness.js";
import { MemoryKnowledgeSourceStore } from "./knowledge/source-store.js";
import { KnowledgeUploadService } from "./knowledge/uploads.js";
import { MemoryObjectStorage } from "./platform/object-storage.js";
import type { SessionAuthentication } from "./platform/session-authentication.js";

const repository = createRepository();
const sourceStore = new MemoryKnowledgeSourceStore();
const objectStorage = new MemoryObjectStorage();
const testAuthentication: SessionAuthentication = {
  async signIn() { return null; },
  async signOut() {},
  async userIdForAccessToken(token) { return token || null; },
  async accountForAccessToken(token) {
    return token ? { id: token, loginName: "e2e", createdAt: "2026-01-01T00:00:00.000Z" } : null;
  },
};
const app = createApp(repository, {
  agent: new DeterministicAgentHarness(repository),
  authentication: testAuthentication,
  knowledgeUploads: new KnowledgeUploadService(repository, objectStorage, sourceStore),
});

const testOwner = (request: Request) => (
  request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  || request.headers.get("x-lessonup-user")
  || ""
);

// Explicitly test-only control points. Browser tests use the same application
// repository/storage instances instead of reaching around the app into a
// legacy vendor database.
app.post("/api/__e2e/knowledge/:id/attach", async (c) => {
  const ownerId = testOwner(c.req.raw);
  if (!ownerId) return c.json({ error: "e2e_owner_required" }, 400);
  const source = await sourceStore.markAttached(ownerId, c.req.param("id"), crypto.randomUUID());
  return source ? c.json(source) : c.json({ error: "knowledge_source_not_found" }, 404);
});

app.get("/api/__e2e/storage", async (c) => {
  const key = c.req.query("key");
  if (!key || !key.startsWith(`${testOwner(c.req.raw)}/`)) return c.json({ error: "e2e_storage_scope_invalid" }, 400);
  return c.json({ exists: Boolean(await objectStorage.get(key)) });
});

app.post("/api/__e2e/runs/expired", async (c) => {
  const ownerId = testOwner(c.req.raw);
  const threads = await repository.listThreads(ownerId, "c1");
  const thread = threads[0];
  if (!thread) return c.json({ error: "thread_not_found" }, 404);
  const branches = await repository.listBranches(ownerId, thread.id);
  const branch = branches[0];
  if (!branch) return c.json({ error: "branch_not_found" }, 404);
  const assistant = await repository.appendMessage({
    ownerId, threadId: thread.id, branchId: branch.id,
    role: "assistant", content: "", status: "streaming", sources: [],
  });
  const run = await repository.createRun({
    id: crypto.randomUUID(), ownerId, threadId: thread.id, branchId: branch.id,
    model: "expired-e2e-run", status: "running", leaseToken: "dead-worker",
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(), assistantMessageId: assistant.id,
  });
  await repository.updateThread(ownerId, thread.id, { status: "running" });
  return c.json(run, 201);
});

app.get("/api/__e2e/runs/:id", async (c) => {
  const run = await repository.getRun(testOwner(c.req.raw), c.req.param("id"));
  return run ? c.json(run) : c.json({ error: "run_not_found" }, 404);
});

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.PORT }, ({ address, port }) => {
  console.log(`LessonUp deterministic E2E API listening at http://${address}:${port}`);
});

const shutdown = () => server.close();
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
