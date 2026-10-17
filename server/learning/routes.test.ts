import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { lessonFieldSchema, lessonPlanSchema } from "../domain.js";

async function fixture() {
  const repository = new MemoryLessonRepository();
  const owner = crypto.randomUUID();
  const notebook = await repository.createNotebook(owner, { title: "语文", subject: "语文", className: "一班", year: "2026", tone: "teal" });
  const document = lessonPlanSchema.parse(Object.fromEntries(lessonFieldSchema.options.map((key) => [key, "教案"] )));
  const file = await repository.createLessonFile(owner, { notebookId: notebook.id, title: "春", type: "教案", document, pageCount: 1 });
  const app = createApp(repository, { agent: null, authentication: {
    userIdForAccessToken: async (token) => token,
    accountForAccessToken: async () => null,
    signIn: async () => null,
    signOut: async () => undefined,
  } });
  const input = { documentVersion: 0, objective: "解释证据", task: "独立解释词句", criterion: "解释词句与结论的联系",
    learnerGroup: "一班", observation: "只能复述句意", method: "student_work", observedAt: new Date(Date.now() - 1000).toISOString(), sourceReference: "课堂解释卡" };
  const headers = { authorization: `Bearer ${owner}`, "content-type": "application/json", "idempotency-key": "learning-command" };
  return { repository, owner, file, app, input, headers };
}

describe("learning API ownership and retry contracts", () => {
  it("requires authentication, enforces ownership, and recovers the exact committed command", async () => {
    const { app, file, input, headers } = await fixture();
    const base = `/api/lesson-files/${file.id}/learning`;
    expect((await app.request(`${base}?evidenceBefore=invalid`, { headers })).status).toBe(400);
    expect((await app.request(base)).status).toBe(401);
    expect((await app.request(base, { headers: { authorization: `Bearer ${crypto.randomUUID()}` } })).status).toBe(404);
    const saved = await app.request(`${base}/evidence`, { method: "POST", headers, body: JSON.stringify(input) });
    expect(saved.status).toBe(201);
    const evidence = await saved.json();
    const retry = await app.request(`${base}/evidence`, { method: "POST", headers, body: JSON.stringify(input) });
    expect(await retry.json()).toEqual(evidence);
    const receipt = await app.request(`${base}/commands/learning-command`, { headers });
    expect(await receipt.json()).toEqual(evidence);
    const conflict = await app.request(`${base}/evidence`, { method: "POST", headers, body: JSON.stringify({ ...input, observation: "不同观察" }) });
    expect(conflict.status).toBe(409);
    const progress = await (await app.request(base, { headers })).json() as { evidence: unknown[] };
    expect(progress.evidence).toHaveLength(1);
  });
});
