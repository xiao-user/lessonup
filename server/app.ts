import { addTraceProcessor } from "@openai/agents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { requireUser, type AppBindings } from "./auth.js";
import { config, hasDeepSeek, runtimeCapabilities } from "./config.js";
import {
  curriculumSemanticRelationSchema,
  createSemesterFrameworkSchema,
  createLessonBlueprintSchema,
  deleteLessonBlueprintSchema,
  lessonContextProfileSchema,
  lessonDesignBasisPatchSchema,
  lessonPlanSchema,
  semesterFrameworkPatchSchema,
  updateLessonBlueprintSchema,
} from "./domain.js";
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
import { canonicalizeLessonContextProfile } from "./curriculum/context-profile.js";
import {
  buildContinuityWritebackHints,
  buildContinuityWritebackSeed,
  needsContinuityWriteback,
} from "./curriculum/continuity-adoption.js";

let tracingConfigured = false;

const selectionSchema = z.object({
  field: z.enum(["unit", "period", "totalPeriods", "topic", "objectives", "knowledgePoints", "continuity", "focus", "preparation", "process", "assessment", "homework", "board", "reflection"]),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
}).refine((value) => value.end >= value.start, "invalid_selection_range");

const runInputSchema = z.object({
  branchId: z.string().min(1),
  message: z.string().trim().min(1).max(20_000),
  activeSectionId: z.string().min(1),
  activeUnitId: z.string().uuid().optional(),
  documentVersion: z.number().int().nonnegative(),
  selection: selectionSchema.optional(),
  attachmentIds: z.array(z.string().uuid()).max(8).default([]),
});

const importedNotebookSchema = z.object({
  id: z.string(), title: z.string(), className: z.string(), year: z.string(), subject: z.string(),
  stage: z.string().optional(), grade: z.string().optional(), edition: z.string().optional(),
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
  if (!tracingConfigured) {
    addTraceProcessor(new LessonTracingProcessor());
    tracingConfigured = true;
  }

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
      stage: z.string().trim().max(40).default(""),
      grade: z.string().trim().max(40).default(""),
      edition: z.string().trim().max(40).default(""),
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
      stage: z.string().trim().max(40).optional(),
      grade: z.string().trim().max(40).optional(),
      edition: z.string().trim().max(40).optional(),
      tone: notebookToneSchema.optional(),
    }).refine((value) => Object.keys(value).length > 0, "empty_patch").parse(await c.req.json());
    return c.json(await repository.updateNotebook(c.get("userId"), c.req.param("id"), input));
  });

  app.delete("/api/notebooks/:id", async (c) => {
    const ownerId = c.get("userId");
    const notebookId = c.req.param("id");
    if (!await repository.getNotebook(ownerId, notebookId)) throw new Error("notebook_not_found");
    await knowledgeUploads.deleteForNotebook(ownerId, notebookId);
    await repository.deleteNotebook(ownerId, notebookId);
    return c.body(null, 204);
  });

  app.post("/api/lesson-files", async (c) => {
    const input = z.object({
      notebookId: z.string().min(1),
      title: z.string().trim().min(1).max(160),
      type: z.string().trim().min(1).max(80).default("新教案"),
      image: z.string().max(500).optional(),
      document: lessonPlanSchema,
      contextProfile: lessonContextProfileSchema.optional(),
      lessonBlueprintId: z.string().uuid().optional(),
      pageCount: z.number().int().positive().default(1),
    }).parse(await c.req.json());
    const notebook = await repository.getNotebook(c.get("userId"), input.notebookId);
    if (!notebook) throw new Error("notebook_not_found");
    const contextProfile = input.contextProfile
      ? await canonicalizeLessonContextProfile({
        repository,
        subject: notebook.subject,
        stage: notebook.stage,
        grade: notebook.grade,
        edition: notebook.edition,
        profile: input.contextProfile,
      })
      : undefined;
    return c.json(await repository.createLessonFile(c.get("userId"), {
      ...input,
      contextProfile,
    }, c.req.header("idempotency-key") ?? crypto.randomUUID()), 201);
  });

  app.patch("/api/lesson-files/:id", async (c) => {
    const input = z.object({
      title: z.string().trim().min(1).max(160).optional(),
      type: z.string().trim().min(1).max(80).optional(),
      image: z.string().max(500).optional(),
      contextProfile: lessonContextProfileSchema.optional(),
    }).refine((value) => Object.keys(value).length > 0, "empty_patch").parse(await c.req.json());
    if (!input.contextProfile) {
      return c.json(await repository.updateLessonFile(c.get("userId"), c.req.param("id"), input));
    }
    const file = await repository.getLessonFile(c.get("userId"), c.req.param("id"));
    if (!file) throw new Error("lesson_file_not_found");
    const notebook = await repository.getNotebook(c.get("userId"), file.notebookId);
    if (!notebook) throw new Error("notebook_not_found");
    const contextProfile = await canonicalizeLessonContextProfile({
      repository,
      subject: notebook.subject,
      stage: notebook.stage,
      grade: notebook.grade,
      edition: notebook.edition,
      profile: input.contextProfile,
    });
    return c.json(await repository.updateLessonFile(c.get("userId"), c.req.param("id"), {
      ...input,
      contextProfile,
    }));
  });

  app.get("/api/lesson-files/:id/design-basis", async (c) => {
    const basis = await repository.getLessonDesignBasis(c.get("userId"), c.req.param("id"));
    return basis
      ? c.json(basis)
      : c.json({ error: "lesson_design_basis_not_found" }, 404);
  });

  app.patch("/api/lesson-files/:id/design-basis", async (c) => {
    const fileId = c.req.param("id");
    const patch = lessonDesignBasisPatchSchema.parse({
      ...await c.req.json(),
      fileId,
    });
    const basis = await repository.getLessonDesignBasis(c.get("userId"), fileId);
    if (!basis || basis.basis.id !== patch.basisId) {
      return c.json({ error: "lesson_design_basis_not_found" }, 404);
    }
    return c.json(await repository.applyManualLessonDesignBasisPatch(
      c.get("userId"),
      patch,
      c.req.header("idempotency-key") ?? crypto.randomUUID(),
    ));
  });

  app.delete("/api/lesson-files/:id", async (c) => {
    const ownerId = c.get("userId");
    const fileId = c.req.param("id");
    if (!await repository.getLessonFile(ownerId, fileId)) throw new Error("lesson_file_not_found");
    await knowledgeUploads.deleteForLessonFile(ownerId, fileId);
    await repository.deleteLessonFile(ownerId, fileId);
    return c.body(null, 204);
  });

  app.get("/api/curriculum/facets", async (c) => (
    c.json(await repository.listCurriculumFacets())
  ));

  app.get("/api/curriculum/catalog/releases/current", async (c) => {
    const release = await repository.getCurrentCurriculumCatalogRelease();
    return release
      ? c.json(release)
      : c.json({ error: "curriculum_catalog_release_not_found" }, 404);
  });

  app.get("/api/curriculum/catalog/releases/:releaseId", async (c) => {
    const releaseId = z.string().uuid().parse(c.req.param("releaseId"));
    const release = await repository.getCurriculumCatalogRelease(releaseId);
    return release
      ? c.json(release)
      : c.json({ error: "curriculum_catalog_release_not_found" }, 404);
  });

  app.get("/api/curriculum/catalog/releases/:releaseId/textbooks/:textbookId", async (c) => {
    const releaseId = z.string().uuid().parse(c.req.param("releaseId"));
    const release = await repository.getCurriculumCatalogRelease(releaseId);
    if (!release?.snapshotComplete) {
      return c.json({ error: "curriculum_catalog_snapshot_unavailable" }, 409);
    }
    const textbook = await repository.getCurriculumTextbook(
      c.req.param("textbookId"),
      releaseId,
    );
    return textbook
      ? c.json({ release, textbook })
      : c.json({ error: "curriculum_textbook_not_found" }, 404);
  });

  app.get("/api/curriculum/catalog/releases/:releaseId/textbooks/:textbookId/nodes", async (c) => {
    const releaseId = z.string().uuid().parse(c.req.param("releaseId"));
    const release = await repository.getCurriculumCatalogRelease(releaseId);
    if (!release?.snapshotComplete) {
      return c.json({ error: "curriculum_catalog_snapshot_unavailable" }, 409);
    }
    const textbook = await repository.getCurriculumTextbook(
      c.req.param("textbookId"),
      releaseId,
    );
    if (!textbook) return c.json({ error: "curriculum_textbook_not_found" }, 404);
    const query = c.req.query();
    const filter = z.object({
      parentId: z.string().trim().min(1).max(80).optional(),
      maxLevel: z.coerce.number().int().min(1).max(8).optional(),
      rootsOnly: z.enum(["true", "false"]).optional(),
    }).parse({
      parentId: query.parentId || undefined,
      maxLevel: query.maxLevel || undefined,
      rootsOnly: query.rootsOnly || undefined,
    });
    const rootsOnly = filter.rootsOnly === "true";
    const nodes = await repository.listCurriculumNodes({
      textbookId: textbook.id,
      catalogReleaseId: releaseId,
      parentId: rootsOnly ? null : filter.parentId,
      maxLevel: filter.maxLevel ?? (rootsOnly ? 1 : 8),
    });
    return c.json({ release, textbook, nodes });
  });

  app.get("/api/curriculum/textbooks", async (c) => {
    const query = c.req.query();
    const filter = z.object({
      stage: z.string().trim().min(1).max(40).optional(),
      subject: z.string().trim().min(1).max(40).optional(),
      edition: z.string().trim().min(1).max(40).optional(),
      grade: z.string().trim().min(1).max(40).optional(),
      query: z.string().trim().min(1).max(80).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).parse({
      stage: query.stage || undefined,
      subject: query.subject || undefined,
      edition: query.edition || undefined,
      grade: query.grade || undefined,
      query: query.query || undefined,
      limit: query.limit || undefined,
    });
    return c.json({
      textbooks: await repository.searchCurriculumTextbooks(filter),
    });
  });

  app.get("/api/curriculum/textbooks/:id", async (c) => {
    const textbook = await repository.getCurriculumTextbook(c.req.param("id"));
    if (!textbook) return c.json({ error: "curriculum_textbook_not_found" }, 404);
    return c.json(textbook);
  });

  app.get("/api/curriculum/textbooks/:id/nodes", async (c) => {
    const textbook = await repository.getCurriculumTextbook(c.req.param("id"));
    if (!textbook) return c.json({ error: "curriculum_textbook_not_found" }, 404);
    const query = c.req.query();
    const filter = z.object({
      parentId: z.string().trim().min(1).max(80).optional(),
      maxLevel: z.coerce.number().int().min(1).max(5).optional(),
      rootsOnly: z.enum(["true", "false"]).optional(),
    }).parse({
      parentId: query.parentId || undefined,
      maxLevel: query.maxLevel || undefined,
      rootsOnly: query.rootsOnly || undefined,
    });
    const rootsOnly = filter.rootsOnly === "true";
    const nodes = await repository.listCurriculumNodes({
      textbookId: textbook.id,
      parentId: rootsOnly ? null : filter.parentId,
      maxLevel: filter.maxLevel ?? (rootsOnly ? 1 : 3),
    });
    return c.json({ textbook, nodes });
  });

  app.get("/api/curriculum/textbooks/:id/nodes/:nodeId/semantics", async (c) => {
    const textbook = await repository.getCurriculumTextbook(c.req.param("id"));
    if (!textbook) return c.json({ error: "curriculum_textbook_not_found" }, 404);
    const nodeId = z.string().trim().min(1).max(80).parse(c.req.param("nodeId"));
    const nodes = await repository.listCurriculumNodes({ textbookId: textbook.id, maxLevel: 8 });
    const node = nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) return c.json({ error: "curriculum_node_not_found" }, 404);
    const semantics = await repository.readCurriculumNodeSemantics({
      textbookId: textbook.id,
      nodeId,
    });
    return c.json({ textbook, node, ...semantics });
  });

  app.get("/api/curriculum/textbooks/:id/nodes/:nodeId/knowledge-points", async (c) => {
    const textbook = await repository.getCurriculumTextbook(c.req.param("id"));
    if (!textbook) return c.json({ error: "curriculum_textbook_not_found" }, 404);
    const nodeId = z.string().trim().min(1).max(80).parse(c.req.param("nodeId"));
    const nodes = await repository.listCurriculumNodes({ textbookId: textbook.id, maxLevel: 8 });
    const node = nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) return c.json({ error: "curriculum_node_not_found" }, 404);
    return c.json({
      textbook,
      node,
      ...await repository.readCurriculumNodeKnowledgePoints({ textbookId: textbook.id, nodeId }),
    });
  });

  app.post("/api/curriculum/textbooks/:id/knowledge-points/batch", async (c) => {
    const textbook = await repository.getCurriculumTextbook(c.req.param("id"));
    if (!textbook) return c.json({ error: "curriculum_textbook_not_found" }, 404);
    const { nodeIds } = z.object({
      nodeIds: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
    }).parse(await c.req.json());
    return c.json({
      records: await repository.readCurriculumNodesKnowledgePoints({
        textbookId: textbook.id,
        nodeIds,
      }),
    });
  });

  app.get("/api/curriculum/textbooks/:id/knowledge-points", async (c) => {
    const textbook = await repository.getCurriculumTextbook(c.req.param("id"));
    if (!textbook) return c.json({ error: "curriculum_textbook_not_found" }, 404);
    const input = z.object({
      query: z.string().trim().min(1).max(200),
      limit: z.coerce.number().int().min(1).max(30).default(12),
    }).parse({ query: c.req.query("query"), limit: c.req.query("limit") || undefined });
    return c.json({
      textbook,
      query: input.query,
      results: await repository.searchCurriculumKnowledgePoints({
        textbookId: textbook.id,
        query: input.query,
        limit: input.limit,
      }),
    });
  });

  app.get("/api/curriculum/textbooks/:id/knowledge-points/:entityId/continuity", async (c) => {
    const textbook = await repository.getCurriculumTextbook(c.req.param("id"));
    if (!textbook) return c.json({ error: "curriculum_textbook_not_found" }, 404);
    const input = z.object({
      entityId: z.string().uuid(),
      currentNodeId: z.string().trim().min(1).max(80),
      limit: z.coerce.number().int().min(1).max(30).default(12),
    }).parse({
      entityId: c.req.param("entityId"),
      currentNodeId: c.req.query("currentNodeId"),
      limit: c.req.query("limit") || undefined,
    });
    return c.json(await repository.readCurriculumKnowledgeContinuity({
      textbookId: textbook.id,
      currentNodeId: input.currentNodeId,
      entityId: input.entityId,
      limit: input.limit,
    }));
  });

  app.get("/api/curriculum/semantics/:id", async (c) => {
    const entityId = z.string().uuid().parse(c.req.param("id"));
    const entity = await repository.getCurriculumSemanticEntity(entityId);
    return entity
      ? c.json(entity)
      : c.json({ error: "curriculum_semantic_entity_not_found" }, 404);
  });

  app.get("/api/curriculum/semantics/:id/path", async (c) => {
    const query = c.req.query();
    const input = z.object({
      entityId: z.string().uuid(),
      direction: z.enum(["backward", "forward"]).default("backward"),
      relationTypes: z.string().trim().optional(),
      maxDepth: z.coerce.number().int().min(1).max(6).default(3),
    }).parse({
      entityId: c.req.param("id"),
      direction: query.direction || undefined,
      relationTypes: query.relationTypes || undefined,
      maxDepth: query.maxDepth || undefined,
    });
    const relationTypes = input.relationTypes
      ? z.array(curriculumSemanticRelationSchema).min(1).max(7).parse(
        input.relationTypes.split(",").map((value) => value.trim()).filter(Boolean),
      )
      : undefined;
    if (!await repository.getCurriculumSemanticEntity(input.entityId)) {
      return c.json({ error: "curriculum_semantic_entity_not_found" }, 404);
    }
    return c.json({
      entityId: input.entityId,
      direction: input.direction,
      steps: await repository.traceCurriculumSemanticPath({
        entityId: input.entityId,
        direction: input.direction,
        relationTypes,
        maxDepth: input.maxDepth,
      }),
    });
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
    if (!knowledgeUploads.storageConfigured) return c.json({ error: "knowledge_storage_not_configured" }, 503);
    const query = z.object({
      notebookId: z.string().min(1).optional(),
      lessonFileId: z.string().min(1).optional(),
      view: z.enum(["drafts", "all"]).default("drafts"),
    }).parse({
      notebookId: c.req.query("notebookId") || undefined,
      lessonFileId: c.req.query("lessonFileId") || undefined,
      view: c.req.query("view") || undefined,
    });
    return c.json(await knowledgeUploads.list(c.get("userId"), {
      notebookId: query.notebookId,
      lessonFileId: query.lessonFileId,
      includeAttached: query.view === "all",
    }));
  });

  app.get("/api/knowledge/uploads/:id", async (c) => {
    if (!knowledgeUploads.storageConfigured) return c.json({ error: "knowledge_storage_not_configured" }, 503);
    return c.json(await knowledgeUploads.get(c.get("userId"), c.req.param("id")));
  });

  app.post("/api/knowledge/uploads/:id/retry", async (c) => {
    return c.json(await knowledgeUploads.retry(c.get("userId"), c.req.param("id")));
  });

  app.delete("/api/knowledge/uploads/:id", async (c) => {
    if (!knowledgeUploads.storageConfigured) return c.json({ error: "knowledge_storage_not_configured" }, 503);
    await knowledgeUploads.delete(c.get("userId"), c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/notebooks/:id/semester-frameworks", async (c) => {
    const ownerId = c.get("userId");
    const notebookId = c.req.param("id");
    if (!await repository.getNotebook(ownerId, notebookId)) {
      return c.json({ error: "notebook_not_found" }, 404);
    }
    return c.json({
      frameworks: await repository.listSemesterFrameworks(ownerId, notebookId),
    });
  });

  app.post("/api/notebooks/:id/semester-frameworks", async (c) => {
    const ownerId = c.get("userId");
    const notebookId = c.req.param("id");
    const input = createSemesterFrameworkSchema.parse(await c.req.json());
    const framework = await repository.createSemesterFramework(
      ownerId,
      notebookId,
      input,
      c.req.header("idempotency-key") ?? crypto.randomUUID(),
    );
    return c.json(framework, 201);
  });

  app.get("/api/semester-frameworks/:id", async (c) => {
    const frameworkId = z.string().uuid().parse(c.req.param("id"));
    const framework = await repository.getSemesterFramework(c.get("userId"), frameworkId);
    return framework
      ? c.json(framework)
      : c.json({ error: "semester_framework_not_found" }, 404);
  });

  app.patch("/api/semester-frameworks/:id", async (c) => {
    const frameworkId = z.string().uuid().parse(c.req.param("id"));
    const patch = semesterFrameworkPatchSchema.parse({
      ...await c.req.json(),
      frameworkId,
    });
    const framework = await repository.getSemesterFramework(c.get("userId"), frameworkId);
    if (!framework) return c.json({ error: "semester_framework_not_found" }, 404);
    return c.json(await repository.applyManualSemesterFrameworkPatch(
      c.get("userId"),
      patch,
      c.req.header("idempotency-key") ?? crypto.randomUUID(),
    ));
  });

  app.post("/api/semester-frameworks/:id/blueprints", async (c) => {
    const frameworkId = z.string().uuid().parse(c.req.param("id"));
    const input = createLessonBlueprintSchema.parse(await c.req.json());
    const framework = await repository.getSemesterFramework(c.get("userId"), frameworkId);
    if (!framework) return c.json({ error: "semester_framework_not_found" }, 404);
    return c.json(await repository.createLessonBlueprint(
      c.get("userId"),
      frameworkId,
      input,
      c.req.header("idempotency-key") ?? crypto.randomUUID(),
    ), 201);
  });

  app.patch("/api/semester-frameworks/:id/blueprints/:blueprintId", async (c) => {
    const frameworkId = z.string().uuid().parse(c.req.param("id"));
    const blueprintId = z.string().uuid().parse(c.req.param("blueprintId"));
    const input = updateLessonBlueprintSchema.parse(await c.req.json());
    const framework = await repository.getSemesterFramework(c.get("userId"), frameworkId);
    if (!framework) return c.json({ error: "semester_framework_not_found" }, 404);
    return c.json(await repository.updateLessonBlueprint(
      c.get("userId"),
      frameworkId,
      blueprintId,
      input,
      c.req.header("idempotency-key") ?? crypto.randomUUID(),
    ));
  });

  app.delete("/api/semester-frameworks/:id/blueprints/:blueprintId", async (c) => {
    const frameworkId = z.string().uuid().parse(c.req.param("id"));
    const blueprintId = z.string().uuid().parse(c.req.param("blueprintId"));
    const input = deleteLessonBlueprintSchema.parse(await c.req.json());
    const framework = await repository.getSemesterFramework(c.get("userId"), frameworkId);
    if (!framework) return c.json({ error: "semester_framework_not_found" }, 404);
    return c.json(await repository.deleteLessonBlueprint(
      c.get("userId"),
      frameworkId,
      blueprintId,
      input,
      c.req.header("idempotency-key") ?? crypto.randomUUID(),
    ));
  });

  app.get("/api/semester-frameworks/:id/continuity", async (c) => {
    const frameworkId = z.string().uuid().parse(c.req.param("id"));
    const framework = await repository.getSemesterFramework(c.get("userId"), frameworkId);
    if (!framework) return c.json({ error: "semester_framework_not_found" }, 404);
    return c.json(await repository.getSemesterFrameworkContinuity(
      c.get("userId"),
      frameworkId,
    ));
  });

  app.post("/api/semester-frameworks/:id/continuity/refresh", async (c) => {
    const frameworkId = z.string().uuid().parse(c.req.param("id"));
    const framework = await repository.getSemesterFramework(c.get("userId"), frameworkId);
    if (!framework) return c.json({ error: "semester_framework_not_found" }, 404);
    return c.json(await repository.refreshSemesterFrameworkContinuity(
      c.get("userId"),
      frameworkId,
    ));
  });

  app.post("/api/semester-frameworks/:id/continuity/decisions", async (c) => {
    const frameworkId = z.string().uuid().parse(c.req.param("id"));
    const framework = await repository.getSemesterFramework(c.get("userId"), frameworkId);
    if (!framework) return c.json({ error: "semester_framework_not_found" }, 404);
    const input = z.object({
      fingerprint: z.string().min(1).optional(),
      candidateId: z.string().min(1).optional(),
      decision: z.enum(["accepted", "dismissed", "candidate"]),
      note: z.string().max(500).optional(),
    }).refine((value) => Boolean(value.fingerprint || value.candidateId), {
      message: "continuity_candidate_required",
    }).parse(await c.req.json());
    try {
      return c.json(await repository.setSemesterFrameworkContinuityDecision(
        c.get("userId"),
        frameworkId,
        input,
      ));
    } catch (error) {
      if (error instanceof Error && error.message === "continuity_candidate_not_found") {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  app.get("/api/lesson-files/:id/class-feedback", async (c) => {
    const lessonFileId = c.req.param("id");
    const file = await repository.getLessonFile(c.get("userId"), lessonFileId);
    if (!file) return c.json({ error: "lesson_file_not_found" }, 404);
    return c.json({
      records: await repository.listLessonClassFeedback(c.get("userId"), { lessonFileId }),
    });
  });

  app.post("/api/lesson-files/:id/class-feedback", async (c) => {
    const lessonFileId = c.req.param("id");
    const file = await repository.getLessonFile(c.get("userId"), lessonFileId);
    if (!file) return c.json({ error: "lesson_file_not_found" }, 404);
    const input = z.object({
      kind: z.enum(["observation", "practice_gap", "error_cause", "continuity_outcome"]),
      statement: z.string().trim().min(1).max(2000),
      lessonBlueprintId: z.string().uuid().nullable().optional(),
      semesterFrameworkId: z.string().uuid().nullable().optional(),
      relatedEntityId: z.string().uuid().nullable().optional(),
      continuityFingerprint: z.string().min(1).nullable().optional(),
      continuityDirection: z.enum(["review", "prepare"]).nullable().optional(),
      continuityOutcome: z.enum(["worked", "weak", "skipped"]).nullable().optional(),
      evidence: z.record(z.string(), z.unknown()).optional(),
    }).superRefine((value, ctx) => {
      if (value.kind !== "continuity_outcome") return;
      if (!value.continuityFingerprint?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["continuityFingerprint"],
          message: "衔接效果反馈必须绑定具体衔接候选",
        });
      }
      if (!value.continuityDirection) {
        ctx.addIssue({
          code: "custom",
          path: ["continuityDirection"],
          message: "衔接效果反馈必须标明复习或铺垫方向",
        });
      }
      if (!value.continuityOutcome) {
        ctx.addIssue({
          code: "custom",
          path: ["continuityOutcome"],
          message: "衔接效果反馈必须标明有效、偏弱或未落实",
        });
      }
    }).parse(await c.req.json());
    const record = await repository.createLessonClassFeedback(c.get("userId"), {
      lessonFileId,
      ...input,
    });
    let writebackSeed: string | null = null;
    if (
      needsContinuityWriteback(record)
      && record.semesterFrameworkId
    ) {
      const aggregate = await repository.getSemesterFramework(
        c.get("userId"),
        record.semesterFrameworkId,
      );
      const hint = buildContinuityWritebackHints(
        [record],
        aggregate?.blueprints ?? [],
      )[0];
      if (hint) writebackSeed = buildContinuityWritebackSeed(hint);
    }
    return c.json({ ...record, writebackSeed }, 201);
  });

  app.get("/api/semester-frameworks/:id/class-feedback", async (c) => {
    const frameworkId = z.string().uuid().parse(c.req.param("id"));
    const framework = await repository.getSemesterFramework(c.get("userId"), frameworkId);
    if (!framework) return c.json({ error: "semester_framework_not_found" }, 404);
    return c.json({
      records: await repository.listLessonClassFeedback(c.get("userId"), {
        semesterFrameworkId: frameworkId,
      }),
    });
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

  app.patch("/api/lesson-files/:id/page-count", async (c) => {
    const input = z.object({
      documentVersion: z.number().int().nonnegative(),
      pageCount: z.number().int().positive(),
    }).parse(await c.req.json());
    return c.json(await repository.updateLessonPageCount({
      ownerId: c.get("userId"),
      fileId: c.req.param("id"),
      documentVersion: input.documentVersion,
      pageCount: input.pageCount,
    }));
  });

  app.get("/api/agent/threads", async (c) => {
    const scope = z.object({
      lessonFileId: z.string().min(1).optional(),
      semesterFrameworkId: z.string().uuid().optional(),
    }).refine(
      (value) => Number(Boolean(value.lessonFileId)) + Number(Boolean(value.semesterFrameworkId)) === 1,
      "agent_resource_scope_invalid",
    ).parse({
      lessonFileId: c.req.query("lessonFileId") || undefined,
      semesterFrameworkId: c.req.query("semesterFrameworkId") || undefined,
    });
    const includeArchived = c.req.query("includeArchived") === "true";
    return c.json(await repository.listThreads(
      c.get("userId"),
      scope.semesterFrameworkId
        ? { resourceType: "semester_framework", semesterFrameworkId: scope.semesterFrameworkId }
        : { resourceType: "lesson_file", lessonFileId: scope.lessonFileId! },
      includeArchived,
    ));
  });

  app.post("/api/agent/threads", async (c) => {
    const input = z.object({
      notebookId: z.string(),
      lessonFileId: z.string().optional(),
      semesterFrameworkId: z.string().uuid().optional(),
      title: z.string().max(80).optional(),
      currentThreadId: z.string().optional(),
      currentBranchId: z.string().optional(),
    }).superRefine((value, context) => {
      if (Boolean(value.currentThreadId) !== Boolean(value.currentBranchId)) {
        context.addIssue({ code: "custom", message: "current_thread_scope_incomplete" });
      }
      if (Number(Boolean(value.lessonFileId)) + Number(Boolean(value.semesterFrameworkId)) !== 1) {
        context.addIssue({ code: "custom", message: "agent_resource_scope_invalid" });
      }
    }).parse(await c.req.json());
    const resource = input.semesterFrameworkId
      ? { resourceType: "semester_framework" as const, semesterFrameworkId: input.semesterFrameworkId }
      : { resourceType: "lesson_file" as const, lessonFileId: input.lessonFileId! };
    const ownerId = c.get("userId");
    if (input.currentThreadId && input.currentBranchId) {
      const [thread, branch, messages] = await Promise.all([
        repository.getThread(ownerId, input.currentThreadId),
        repository.getBranch(ownerId, input.currentThreadId, input.currentBranchId),
        repository.listMessages(ownerId, input.currentThreadId, input.currentBranchId, undefined, 1),
      ]);
      const sameResource = resource.resourceType === "lesson_file"
        ? thread?.resourceType === "lesson_file" && thread.lessonFileId === resource.lessonFileId
        : thread?.resourceType === "semester_framework"
          && thread.semesterFrameworkId === resource.semesterFrameworkId;
      if (!thread || !branch || !sameResource) {
        return c.json({ error: "current_thread_scope_invalid" }, 404);
      }
      if (!messages.length) return c.json({ error: "current_thread_empty" }, 409);
    }
    const created = await repository.createThread(
      ownerId,
      { notebookId: input.notebookId, title: input.title, ...resource },
      c.req.header("idempotency-key") ?? crypto.randomUUID(),
    );
    return c.json(created, 201);
  });

  app.post("/api/agent/threads/:id/starters", async (c) => {
    if (!threadStarterGenerator) return c.json({ error: "agent_not_configured" }, 503);
    const ownerId = c.get("userId");
    const thread = await repository.getThread(ownerId, c.req.param("id"));
    if (!thread) return c.json({ error: "thread_not_found" }, 404);
    const notebook = await repository.getNotebook(ownerId, thread.notebookId);
    if (!notebook) return c.json({ error: "notebook_not_found" }, 404);
    let updated;
    if (thread.resourceType === "semester_framework") {
      const framework = await repository.getSemesterFramework(
        ownerId,
        thread.semesterFrameworkId,
      );
      if (!framework) return c.json({ error: "semester_framework_not_found" }, 404);
      updated = await repository.updateThread(ownerId, thread.id, {
        starterSuggestions: await threadStarterGenerator({ notebook, framework }),
        starterSuggestionsResourceVersion: framework.framework.version,
      });
    } else {
      const file = await repository.getLessonFile(ownerId, thread.lessonFileId);
      if (!file) return c.json({ error: "lesson_file_not_found" }, 404);
      updated = await repository.updateThread(ownerId, thread.id, {
        starterSuggestions: await threadStarterGenerator({ notebook, file }),
        starterSuggestionsDocumentVersion: file.documentVersion,
      });
    }
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
      continuationMessageId: approval.continuationMessageId,
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
    await repository.recoverExpiredRuns(userId, threadId);
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
