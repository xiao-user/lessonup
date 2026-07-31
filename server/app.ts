import { setTraceProcessors } from "@openai/agents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { requireUser, type AppBindings } from "./auth.js";
import { config, hasDeepSeek, runtimeCapabilities } from "./config.js";
import { lessonPlanSchema } from "./domain.js";
import { LessonAgentHarness } from "./agent/harness.js";
import { publicAgentError } from "./agent/public-error.js";
import { handleMcpRequest } from "./mcp/servers.js";
import type { ImportedNotebook, LessonRepository } from "./repository.js";
import { createRepository } from "./repositories/index.js";
import { verifyMcpScopeToken } from "./security/mcp-token.js";
import { LessonTracingProcessor } from "./tracing.js";
import { TavilyWebSearchProvider } from "./providers/web-search.js";
import { KnowledgeUploadService } from "./knowledge/uploads.js";
import { publicApiError } from "./public-api-error.js";
import { shouldPersistRunEvent } from "./run-event-persistence.js";
import { generateThreadStarters } from "./agent/thread-starters.js";

const selectionSchema = z.object({
  field: z.enum(["unit", "period", "totalPeriods", "topic", "objectives", "focus", "preparation", "process", "assessment", "homework", "board", "reflection"]),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
}).refine((value) => value.end >= value.start, "invalid_selection_range");

const runInputSchema = z.object({
  branchId: z.string().min(1),
  message: z.string().trim().min(1).max(20_000),
  activeSectionId: z.string().min(1),
  documentVersion: z.number().int().nonnegative(),
  selection: selectionSchema.optional(),
  attachmentIds: z.array(z.string().uuid()).max(8).default([]),
});

const importedNotebookSchema = z.object({
  id: z.string(), title: z.string(), className: z.string(), year: z.string(), subject: z.string(),
  tone: z.enum(["teal", "sage", "amber", "coral"]).optional(),
  files: z.array(z.object({
    id: z.string(), title: z.string(), type: z.string().optional(), image: z.string().optional(),
    pages: z.number().int().positive().optional(),
    documentVersion: z.number().int().nonnegative().optional(),
    lessonPlan: lessonPlanSchema,
  })),
});

const notebookToneSchema = z.enum(["teal", "sage", "amber", "coral"]);

type AgentHarnessRuntime = Pick<LessonAgentHarness, "start" | "cancel" | "resumeApproval">;

export function createApp(
  repository: LessonRepository = createRepository(),
  options: {
    harness?: AgentHarnessRuntime | null;
    threadStarterGenerator?: typeof generateThreadStarters | null;
  } = {},
) {
  const app = new Hono<AppBindings>();
  const harness = options.harness === undefined
    ? hasDeepSeek ? new LessonAgentHarness(repository) : null
    : options.harness;
  const webProvider = new TavilyWebSearchProvider();
  const knowledgeUploads = new KnowledgeUploadService(repository);
  const threadStarterGenerator = options.threadStarterGenerator === undefined
    ? config.NODE_ENV === "test" || !hasDeepSeek ? null : generateThreadStarters
    : options.threadStarterGenerator;
  setTraceProcessors([new LessonTracingProcessor()]);

  app.use("*", logger());
  app.use("*", cors({
    origin: config.APP_ORIGIN,
    allowHeaders: [
      "authorization",
      "content-type",
      "idempotency-key",
      ...(config.NODE_ENV === "test" ? ["x-lessonup-user"] : []),
      "mcp-protocol-version",
    ],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  }));

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/runtime", (c) => c.json(runtimeCapabilities));

  app.all("/mcp/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "knowledge" && kind !== "web") return c.json({ error: "mcp_not_found" }, 404);
    const authorization = c.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) return c.json({ error: "mcp_auth_required" }, 401);
    try {
      const scope = await verifyMcpScopeToken(authorization.slice(7));
      return await handleMcpRequest({ kind, request: c.req.raw, repository, scope, webProvider });
    } catch {
      return c.json({ error: "mcp_auth_invalid" }, 401);
    }
  });

  app.use("/api/*", requireUser);

  app.post("/api/bootstrap/import", async (c) => {
    const input = z.object({ notebooks: z.array(importedNotebookSchema) }).parse(await c.req.json());
    return c.json(await repository.importNotebookGraph(c.get("userId"), input.notebooks as ImportedNotebook[]));
  });

  app.get("/api/notebooks", async (c) => (
    c.json(await repository.listNotebooks(c.get("userId")))
  ));

  app.post("/api/notebooks", async (c) => {
    const input = z.object({
      title: z.string().trim().min(1).max(120),
      className: z.string().trim().min(1).max(120),
      year: z.string().trim().min(1).max(40),
      subject: z.string().trim().min(1).max(80),
      tone: notebookToneSchema,
    }).parse(await c.req.json());
    return c.json(await repository.createNotebook(c.get("userId"), input), 201);
  });

  app.patch("/api/notebooks/:id", async (c) => {
    const input = z.object({
      title: z.string().trim().min(1).max(120).optional(),
      className: z.string().trim().min(1).max(120).optional(),
      year: z.string().trim().min(1).max(40).optional(),
      subject: z.string().trim().min(1).max(80).optional(),
      tone: notebookToneSchema.optional(),
    }).refine((value) => Object.keys(value).length > 0, "empty_patch").parse(await c.req.json());
    return c.json(await repository.updateNotebook(c.get("userId"), c.req.param("id"), input));
  });

  app.delete("/api/notebooks/:id", async (c) => {
    await repository.deleteNotebook(c.get("userId"), c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/api/lesson-files", async (c) => {
    const input = z.object({
      notebookId: z.string().min(1),
      title: z.string().trim().min(1).max(160),
      type: z.string().trim().min(1).max(80).default("新教案"),
      image: z.string().max(500).optional(),
      document: lessonPlanSchema,
      pageCount: z.number().int().positive().default(1),
    }).parse(await c.req.json());
    return c.json(await repository.createLessonFile(c.get("userId"), input), 201);
  });

  app.patch("/api/lesson-files/:id", async (c) => {
    const input = z.object({
      title: z.string().trim().min(1).max(160).optional(),
      type: z.string().trim().min(1).max(80).optional(),
      image: z.string().max(500).optional(),
    }).refine((value) => Object.keys(value).length > 0, "empty_patch").parse(await c.req.json());
    return c.json(await repository.updateLessonFile(c.get("userId"), c.req.param("id"), input));
  });

  app.delete("/api/lesson-files/:id", async (c) => {
    await repository.deleteLessonFile(c.get("userId"), c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/api/knowledge/uploads", async (c) => {
    if (!knowledgeUploads.configured) return c.json({ error: "knowledge_indexing_not_configured" }, 503);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "knowledge_file_required" }, 400);
    const optional = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    return c.json(await knowledgeUploads.enqueue(c.get("userId"), {
      file,
      notebookId: optional("notebookId"),
      lessonFileId: optional("lessonFileId"),
      title: optional("title"),
      idempotencyKey: c.req.header("idempotency-key") ?? crypto.randomUUID(),
    }), 202);
  });

  app.get("/api/knowledge/uploads", async (c) => {
    if (!knowledgeUploads.configured) return c.json({ error: "knowledge_indexing_not_configured" }, 503);
    return c.json(await knowledgeUploads.list(c.get("userId"), {
      notebookId: c.req.query("notebookId"),
      lessonFileId: c.req.query("lessonFileId"),
    }));
  });

  app.get("/api/knowledge/uploads/:id", async (c) => {
    if (!knowledgeUploads.configured) return c.json({ error: "knowledge_indexing_not_configured" }, 503);
    return c.json(await knowledgeUploads.get(c.get("userId"), c.req.param("id")));
  });

  app.post("/api/knowledge/uploads/:id/retry", async (c) => {
    return c.json(await knowledgeUploads.retry(c.get("userId"), c.req.param("id")));
  });

  app.delete("/api/knowledge/uploads/:id", async (c) => {
    await knowledgeUploads.delete(c.get("userId"), c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/lesson-files/:id", async (c) => {
    const file = await repository.getLessonFile(c.get("userId"), c.req.param("id"));
    return file ? c.json(file) : c.json({ error: "lesson_file_not_found" }, 404);
  });

  app.patch("/api/lesson-files/:id/document", async (c) => {
    const input = z.object({
      baseVersion: z.number().int().nonnegative(),
      document: lessonPlanSchema,
      pageCount: z.number().int().positive(),
      source: z.enum(["manual", "undo"]).default("manual"),
    }).parse(await c.req.json());
    const idempotencyKey = c.req.header("idempotency-key") ?? crypto.randomUUID();
    const file = await repository.saveLessonDocument({
      ownerId: c.get("userId"), fileId: c.req.param("id"),
      baseVersion: input.baseVersion, document: input.document, pageCount: input.pageCount,
      source: input.source, idempotencyKey,
    });
    return c.json(file);
  });

  app.get("/api/agent/threads", async (c) => {
    const fileId = z.string().min(1).parse(c.req.query("lessonFileId"));
    const includeArchived = c.req.query("includeArchived") === "true";
    return c.json(await repository.listThreads(c.get("userId"), fileId, includeArchived));
  });

  app.post("/api/agent/threads", async (c) => {
    const input = z.object({
      notebookId: z.string(),
      lessonFileId: z.string(),
      title: z.string().max(80).optional(),
      currentThreadId: z.string().optional(),
      currentBranchId: z.string().optional(),
    }).refine(
      (value) => Boolean(value.currentThreadId) === Boolean(value.currentBranchId),
      "current_thread_scope_incomplete",
    ).parse(await c.req.json());
    const ownerId = c.get("userId");
    if (input.currentThreadId && input.currentBranchId) {
      const [thread, branch, messages] = await Promise.all([
        repository.getThread(ownerId, input.currentThreadId),
        repository.getBranch(ownerId, input.currentThreadId, input.currentBranchId),
        repository.listMessages(ownerId, input.currentThreadId, input.currentBranchId, undefined, 1),
      ]);
      if (!thread || !branch || thread.lessonFileId !== input.lessonFileId) {
        return c.json({ error: "current_thread_scope_invalid" }, 404);
      }
      if (!messages.length) return c.json({ error: "current_thread_empty" }, 409);
    }
    const created = await repository.createThread(ownerId, input);
    return c.json(created, 201);
  });

  app.post("/api/agent/threads/:id/starters", async (c) => {
    if (!threadStarterGenerator) return c.json({ error: "agent_not_configured" }, 503);
    const ownerId = c.get("userId");
    const thread = await repository.getThread(ownerId, c.req.param("id"));
    if (!thread) return c.json({ error: "thread_not_found" }, 404);
    const [notebook, file] = await Promise.all([
      repository.getNotebook(ownerId, thread.notebookId),
      repository.getLessonFile(ownerId, thread.lessonFileId),
    ]);
    if (!notebook || !file) return c.json({ error: "lesson_file_not_found" }, 404);
    const updated = await repository.updateThread(ownerId, thread.id, {
      starterSuggestions: await threadStarterGenerator({ notebook, file }),
      starterSuggestionsDocumentVersion: file.documentVersion,
    });
    return c.json(updated);
  });

  app.patch("/api/agent/threads/:id", async (c) => {
    const input = z.object({ title: z.string().min(1).max(80).optional(), archived: z.boolean().optional() })
      .parse(await c.req.json());
    return c.json(await repository.updateThread(c.get("userId"), c.req.param("id"), {
      title: input.title,
      archivedAt: input.archived === undefined ? undefined : input.archived ? new Date().toISOString() : undefined,
    }));
  });

  app.delete("/api/agent/threads/:id", async (c) => {
    await repository.updateThread(c.get("userId"), c.req.param("id"), { deletedAt: new Date().toISOString() });
    return c.body(null, 204);
  });

  app.get("/api/agent/threads/:id/messages", async (c) => {
    const branchId = z.string().min(1).parse(c.req.query("branchId"));
    return c.json(await repository.listMessages(
      c.get("userId"), c.req.param("id"), branchId, c.req.query("cursor"),
    ));
  });

  app.get("/api/agent/threads/:id/branches", async (c) => (
    c.json(await repository.listBranches(c.get("userId"), c.req.param("id")))
  ));

  app.get("/api/agent/threads/:id/approvals", async (c) => {
    const branchId = z.string().min(1).parse(c.req.query("branchId"));
    const approvals = await repository.listApprovals(c.get("userId"), c.req.param("id"), branchId);
    return c.json(approvals.map((approval) => ({
      id: approval.id,
      runId: approval.runId,
      assistantMessageId: approval.assistantMessageId,
      state: approval.state,
      continuationStatus: approval.continuationStatus,
      patch: approval.patch,
      expiresAt: approval.expiresAt,
      createdAt: approval.createdAt,
    })));
  });

  app.get("/api/agent/threads/:id/activity", async (c) => {
    const userId = c.get("userId");
    const threadId = c.req.param("id");
    const branchId = z.string().min(1).parse(c.req.query("branchId"));
    const [thread, branch] = await Promise.all([
      repository.getThread(userId, threadId),
      repository.getBranch(userId, threadId, branchId),
    ]);
    if (!thread || !branch) return c.json({ error: "thread_scope_invalid" }, 403);
    const run = await repository.getLatestRun(userId, threadId, branchId);
    return c.json({
      run,
      events: run ? await repository.listRunEvents(userId, run.id) : [],
    });
  });

  app.post("/api/agent/messages/:id/branch", async (c) => {
    const input = z.object({ threadId: z.string(), branchId: z.string(), editedContent: z.string().optional() })
      .parse(await c.req.json());
    const branch = await repository.createBranch(
      c.get("userId"), input.threadId, input.branchId, c.req.param("id"),
    );
    if (input.editedContent) {
      await repository.appendMessage({
        ownerId: c.get("userId"), threadId: input.threadId, branchId: branch.id,
        role: "user", content: input.editedContent, status: "completed",
      });
    }
    return c.json(branch, 201);
  });

  app.post("/api/agent/threads/:id/runs", async (c) => {
    if (!harness) return c.json({ error: "agent_not_configured" }, 503);
    const input = runInputSchema.parse(await c.req.json());
    const userId = c.get("userId");
    return streamSSE(c, async (stream) => {
      const emit = async (event: Parameters<Parameters<typeof harness.start>[1]>[0]) => {
        if (event.runId !== "unknown" && shouldPersistRunEvent(event)) {
          await repository.appendRunEvent(userId, event.runId, event.type, event);
        }
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => undefined);
      };
      try {
        await harness.start({ userId, threadId: c.req.param("id"), ...input }, emit);
      } catch (error) {
        await emit({
          type: "run.failed", runId: "unknown",
          error: publicAgentError(error),
        });
      }
    });
  });

  app.post("/api/agent/runs/:id/cancel", async (c) => {
    if (!harness) return c.json({ error: "agent_not_configured" }, 503);
    return await harness.cancel(c.get("userId"), c.req.param("id"))
      ? c.json({ cancelled: true })
      : c.json({ error: "active_run_not_found" }, 404);
  });

  app.post("/api/agent/runs/:runId/approvals/:approvalId", async (c) => {
    if (!harness) return c.json({ error: "agent_not_configured" }, 503);
    const input = z.object({ approved: z.boolean() }).parse(await c.req.json());
    const userId = c.get("userId");
    const idempotencyKey = c.req.header("idempotency-key") ?? crypto.randomUUID();
    return streamSSE(c, async (stream) => {
      const emit = async (event: Parameters<Parameters<typeof harness.resumeApproval>[0]["emit"]>[0]) => {
        if (shouldPersistRunEvent(event)) {
          await repository.appendRunEvent(userId, event.runId, event.type, event);
        }
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => undefined);
      };
      try {
        await harness.resumeApproval({
          userId,
          runId: c.req.param("runId"),
          approvalId: c.req.param("approvalId"),
          approved: input.approved,
          idempotencyKey, emit,
        });
      } catch (error) {
        console.error(
          "Agent approval continuation failed",
          error instanceof Error ? error.message : "unknown_error",
        );
        await emit({
          type: "run.failed", runId: c.req.param("runId"),
          error: publicAgentError(error, "approval_resume_failed"),
        });
      }
    });
  });

  app.onError((error, c) => {
    const publicError = publicApiError(error);
    if (publicError.status === 500) {
      console.error("Unhandled API error", error instanceof Error ? error.message : "unknown_error");
    }
    return c.json({ error: publicError.code }, publicError.status);
  });

  return app;
}
