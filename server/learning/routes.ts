import type { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import type { LessonRepository } from "../repository.js";
import { LearningService } from "./service.js";

/** Authentication remains the app's middleware; all resource ids are server-scoped. */
export function registerLearningRoutes(app: Hono<AppBindings>, repository: LessonRepository) {
  const service = new LearningService(repository);
  const cursor = (value?: string): unknown => { if (!value) return undefined; try { return JSON.parse(value); } catch { return value; } };
  app.get("/api/lesson-files/:id/learning", async (c) => c.json(await service.read({ ownerId: c.get("userId"), lessonFileId: c.req.param("id") }, {
    evidenceBefore: cursor(c.req.query("evidenceBefore")),
    inquiriesBefore: cursor(c.req.query("inquiriesBefore")),
  })));
  app.get("/api/lesson-files/:id/learning/inquiries/:inquiryId", async (c) => c.json(await service.readContext(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") }, { inquiryId: c.req.param("inquiryId") },
  )));
  app.get("/api/lesson-files/:id/learning/commands/:key", async (c) => c.json(await service.commandResult(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") }, c.req.param("key"),
  )));
  app.post("/api/lesson-files/:id/learning/evidence", async (c) => c.json(await service.recordEvidence(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") }, await c.req.json(), c.req.header("idempotency-key") ?? "",
  ), 201));
  app.post("/api/lesson-files/:id/learning/inquiries", async (c) => c.json(await service.propose(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") }, await c.req.json(), c.req.header("idempotency-key") ?? "",
  ), 201));
  app.patch("/api/lesson-files/:id/learning/inquiries/:inquiryId", async (c) => c.json(await service.act(
    { ownerId: c.get("userId"), lessonFileId: c.req.param("id") }, c.req.param("inquiryId"), await c.req.json(), c.req.header("idempotency-key") ?? "",
  )));
}
