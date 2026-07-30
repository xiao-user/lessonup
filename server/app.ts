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
  selection: selectionSchema.optional(),
});

const importedNotebookSchema = z.object({
  id: z.string(), title: z.string(), className: z.string(), year: z.string(), subject: z.string(),
  files: z.array(z.object({
    id: z.string(), title: z.string(), type: z.string().optional(), image: z.string().optional(),
    pages: z.number().int().positive().optional(),
    documentVersion: z.number().int().nonnegative().optional(),
    lessonPlan: lessonPlanSchema,
  })),
});

type AgentHarnessRuntime = Pick<LessonAgentHarness, "start" | "cancel" | "resumeApproval">;

export function createApp(
  repository: LessonRepository = createRepository(),
  options: { harness?: AgentHarnessRuntime | null } = {},
) {
  const app = new Hono<AppBindings>();
  const harness = options.harness === undefined
    ? hasDeepSeek ? new LessonAgentHarness(repository) : null
    : options.harness;
  const webProvider = new TavilyWebSearchProvider();
  const knowledgeUploads = new KnowledgeUploadService(repository);
  setTraceProcessors([new LessonTracingProcessor()]);

  app.use("*", logger());
  app.use("*", cors({
    origin: config.APP_ORIGIN,
    allowHeaders: ["authorization", "content-type", "idempotency-key", "x-lessonup-user", "mcp-protocol-version"],
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
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "mcp_request_failed" }, 401);
    }
  });

  app.use("/api/*", requireUser);

  app.post("/api/bootstrap/import", async (c) => {
    const input = z.object({ notebooks: z.array(importedNotebookSchema) }).parse(await c.req.json());
    return c.json(await repository.importNotebookGraph(c.get("userId"), input.notebooks as ImportedNotebook[]));
  });

  app.post("/api/knowledge/uploads", async (c) => {
    if (!knowledgeUploads.configured) return c.json({ error: "knowledge_storage_not_configured" }, 503);
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
    }), 202);
  });

  app.get("/api/knowledge/uploads/:id", async (c) => {
    if (!knowledgeUploads.configured) return c.json({ error: "knowledge_storage_not_configured" }, 503);
    return c.json(await knowledgeUploads.get(c.get("userId"), c.req.param("id")));
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
    const input = z.object({ notebookId: z.string(), lessonFileId: z.string(), title: z.string().max(80).optional() })
      .parse(await c.req.json());
    return c.json(await repository.createThread(c.get("userId"), input), 201);
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
    const approvals = await repository.listPendingApprovals(c.get("userId"), c.req.param("id"), branchId);
    return c.json(approvals.map((approval) => ({
      id: approval.id,
      runId: approval.runId,
      state: approval.state,
      patch: approval.patch,
      expiresAt: approval.expiresAt,
      createdAt: approval.createdAt,
    })));
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
        if (event.runId !== "unknown") {
          await repository.appendRunEvent(userId, event.runId, event.type, event);
        }
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
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
        await repository.appendRunEvent(userId, event.runId, event.type, event);
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      };
      try {
        await harness.resumeApproval({
          userId, approvalId: c.req.param("approvalId"), approved: input.approved,
          idempotencyKey, emit,
        });
      } catch (error) {
        await emit({
          type: "run.failed", runId: c.req.param("runId"),
          error: publicAgentError(error, "approval_resume_failed"),
        });
      }
    });
  });

  app.onError((error, c) => {
    const message = error instanceof z.ZodError
      ? error.issues[0]?.message ?? "invalid_request"
      : error.message;
    const status = message.includes("not_found") ? 404
      : message.includes("stale_document") || message.includes("active_run") || message.includes("already_resolved") ? 409
      : message.includes("scope") || message.includes("denied") ? 403
      : 400;
    return c.json({ error: message }, status);
  });

  return app;
}
