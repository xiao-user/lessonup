import type { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import type { LessonRepository } from "../repository.js";
import { DecisionService } from "./service.js";

/** Teacher-owned decision routes; the agent uses the same service through its tools. */
export function registerDecisionRoutes(app: Hono<AppBindings>, repository: LessonRepository) {
  const service = new DecisionService(repository);
  const cursor = (value?: string): unknown => {
    if (!value) return undefined;
    try { return JSON.parse(value); } catch { return value; }
  };
  app.get("/api/lesson-files/:id/decisions", async (c) => c.json(await service.read(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") },
    { limit: c.req.query("limit"), before: cursor(c.req.query("before")) },
  )));
  app.get("/api/lesson-files/:id/decisions/commands/:key", async (c) => c.json(await service.commandResult(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") }, c.req.param("key"),
  )));
  app.get("/api/lesson-files/:id/decisions/:decisionId", async (c) => c.json(await service.readContext(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") }, c.req.param("decisionId"),
  )));
  app.post("/api/lesson-files/:id/decisions", async (c) => c.json(await service.propose(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") },
    await c.req.json(),
    c.req.header("idempotency-key") ?? "",
  ), 201));
  app.patch("/api/lesson-files/:id/decisions/:decisionId", async (c) => c.json(await service.act(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") },
    c.req.param("decisionId"),
    await c.req.json(),
    c.req.header("idempotency-key") ?? "",
  )));
}
