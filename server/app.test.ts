import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { MemoryLessonRepository } from "./repositories/memory-repository.js";

const document = {
  unit: "单元", period: "1", totalPeriods: "1", topic: "课题", objectives: "目标",
  knowledgePoints: "知识点",
  continuity: "",
  focus: "重点", preparation: "准备", process: "过程", assessment: "评价",
  homework: "作业", board: "板书", reflection: "反思",
};

describe("LessonUp API scope", () => {
  it("imports data, creates a thread, and blocks another test user", async () => {
    const app = createApp(new MemoryLessonRepository());
    const userA = "00000000-0000-4000-8000-00000000000a";
    const userB = "00000000-0000-4000-8000-00000000000b";
    const importResponse = await app.request("/api/bootstrap/import", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userA },
      body: JSON.stringify({ notebooks: [{
        id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
        files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
      }] }),
    });
    expect(importResponse.status).toBe(200);

    const threadResponse = await app.request("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userA },
      body: JSON.stringify({ notebookId: "n1", lessonFileId: "f1" }),
    });
    expect(threadResponse.status).toBe(201);

    const forbiddenRead = await app.request("/api/lesson-files/f1", {
      headers: { "x-lessonup-user": userB },
    });
    expect(forbiddenRead.status).toBe(404);
  });

  it("does not accept knowledge uploads without the complete indexing configuration", async () => {
    const app = createApp(new MemoryLessonRepository());
    const response = await app.request("/api/knowledge/uploads", {
      method: "POST",
      headers: { "x-lessonup-user": "00000000-0000-4000-8000-00000000000a" },
      body: new FormData(),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_indexing_not_configured" });
  });

  it("serves published curriculum semantics and forward learning paths", async () => {
    const app = createApp(new MemoryLessonRepository(), { harness: null });
    const headers = { "x-lessonup-user": "00000000-0000-4000-8000-00000000000a" };
    const semanticResponse = await app.request(
      "/api/curriculum/textbooks/textbook-math-bnu/nodes/ch1-1/semantics",
      { headers },
    );
    expect(semanticResponse.status).toBe(200);
    const semantics = await semanticResponse.json() as {
      mappings: Array<{ entity: { id: string; canonicalName: string } }>;
    };
    expect(semantics.mappings[0]?.entity.canonicalName).toBe("周期变化");

    const entityId = semantics.mappings[0]!.entity.id;
    const pathResponse = await app.request(
      `/api/curriculum/semantics/${entityId}/path?direction=forward&maxDepth=2`,
      { headers },
    );
    expect(pathResponse.status).toBe(200);
    const path = await pathResponse.json() as {
      steps: Array<{ reachedEntity: { canonicalName: string } }>;
    };
    expect(path.steps[0]?.reachedEntity.canonicalName).toBe("三角函数");
  });

  it("serves chapter knowledge points, search, and continuity candidates", async () => {
    const app = createApp(new MemoryLessonRepository(), { harness: null });
    const headers = { "x-lessonup-user": "00000000-0000-4000-8000-00000000000a" };
    const nodeResponse = await app.request(
      "/api/curriculum/textbooks/textbook-math-bnu/nodes/ch1-1/knowledge-points",
      { headers },
    );
    expect(nodeResponse.status).toBe(200);
    const node = await nodeResponse.json() as { points: Array<{ point: { canonicalName: string } }> };
    expect(node.points[0]?.point.canonicalName).toBe("周期变化");

    const batchResponse = await app.request(
      "/api/curriculum/textbooks/textbook-math-bnu/knowledge-points/batch",
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ nodeIds: ["ch1", "ch1-1"] }),
      },
    );
    expect(batchResponse.status).toBe(200);
    const batch = await batchResponse.json() as {
      records: Record<string, { points: Array<{ point: { canonicalName: string } }> }>;
    };
    expect(batch.records["ch1"]?.points[0]?.point.canonicalName).toBe("三角函数");
    expect(batch.records["ch1-1"]?.points[0]?.point.canonicalName).toBe("周期变化");

    const searchResponse = await app.request(
      "/api/curriculum/textbooks/textbook-math-bnu/knowledge-points?query=%E5%91%A8%E6%9C%9F%E5%8F%98%E5%8C%96",
      { headers },
    );
    expect(searchResponse.status).toBe(200);
    const search = await searchResponse.json() as { results: Array<{ point: { id: string } }> };
    expect(search.results).toHaveLength(1);

    const continuityResponse = await app.request(
      "/api/curriculum/textbooks/textbook-math-bnu/knowledge-points/00000000-0000-4000-8000-000000000402/continuity?currentNodeId=ch1",
      { headers },
    );
    expect(continuityResponse.status).toBe(200);
    const continuity = await continuityResponse.json() as {
      candidates: Array<{ occurrences: Array<{ position: string }> }>;
    };
    expect(continuity.candidates[0]?.occurrences[0]?.position).toBe("before");
  });

  it("reads the current curriculum release and its immutable outline", async () => {
    const app = createApp(new MemoryLessonRepository(), { harness: null });
    const headers = { "x-lessonup-user": "00000000-0000-4000-8000-00000000000a" };
    const releaseResponse = await app.request(
      "/api/curriculum/catalog/releases/current",
      { headers },
    );
    expect(releaseResponse.status).toBe(200);
    const release = await releaseResponse.json() as {
      id: string;
      status: string;
      snapshotComplete: boolean;
    };
    expect(release).toMatchObject({ status: "published", snapshotComplete: true });

    const outlineResponse = await app.request(
      `/api/curriculum/catalog/releases/${release.id}`
        + "/textbooks/textbook-math-bnu/nodes?rootsOnly=true",
      { headers },
    );
    expect(outlineResponse.status).toBe(200);
    const outline = await outlineResponse.json() as {
      release: { id: string };
      nodes: Array<{ nodeId: string; title: string }>;
    };
    expect(outline.release.id).toBe(release.id);
    expect(outline.nodes).toContainEqual(expect.objectContaining({ nodeId: "ch1" }));
  });

  it("creates an isolated semester framework pinned to the curriculum release", async () => {
    const repository = new MemoryLessonRepository();
    const app = createApp(repository, {
      harness: null,
      threadStarterGenerator: async ({ framework }) => [
        `检查${framework?.units.length ?? 0}个单元的课时容量`,
        "梳理当前单元的复习与铺垫",
      ],
    });
    const userA = "00000000-0000-4000-8000-00000000000a";
    const userB = "00000000-0000-4000-8000-00000000000b";
    await repository.importNotebookGraph(userA, [{
      id: "n-semester",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const requestBody = {
      textbookId: "textbook-math-bnu",
      title: "七年级上学期教学框架",
      term: "上学期",
      startDate: "2026-09-01",
      totalWeeks: 18,
      weeklyPeriods: 5,
      lessonDurationMinutes: 40,
      capacityRatio: 0.9,
      planningHorizonWeeks: 2,
      contextProfile: { classSummary: "计算基础差异较大" },
    };
    const headers = {
      "content-type": "application/json",
      "x-lessonup-user": userA,
      "idempotency-key": "semester-create-1",
    };
    const createResponse = await app.request(
      "/api/notebooks/n-semester/semester-frameworks",
      { method: "POST", headers, body: JSON.stringify(requestBody) },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      framework: { id: string; catalogReleaseId: string; version: number };
      units: Array<{ curriculumNodeId: string }>;
    };
    expect(created.framework).toMatchObject({ version: 0 });
    expect(created.framework.catalogReleaseId).toBeTruthy();
    expect(created.units).toContainEqual(expect.objectContaining({ curriculumNodeId: "ch1" }));

    const continuityResponse = await app.request(
      `/api/semester-frameworks/${created.framework.id}/continuity/refresh`,
      { method: "POST", headers: { "x-lessonup-user": userA } },
    );
    expect(continuityResponse.status).toBe(200);
    await expect(continuityResponse.json()).resolves.toMatchObject({
      status: "available",
      frameworkVersion: 0,
    });

    const repeatedResponse = await app.request(
      "/api/notebooks/n-semester/semester-frameworks",
      { method: "POST", headers, body: JSON.stringify(requestBody) },
    );
    const repeated = await repeatedResponse.json() as { framework: { id: string } };
    expect(repeated.framework.id).toBe(created.framework.id);

    const threadResponse = await app.request("/api/agent/threads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lessonup-user": userA,
        "idempotency-key": "semester-thread-1",
      },
      body: JSON.stringify({
        notebookId: "n-semester",
        semesterFrameworkId: created.framework.id,
      }),
    });
    expect(threadResponse.status).toBe(201);
    const semesterThread = await threadResponse.json() as {
      thread: { id: string; resourceType: string; semesterFrameworkId: string; lessonFileId?: string };
    };
    expect(semesterThread.thread).toMatchObject({
      resourceType: "semester_framework",
      semesterFrameworkId: created.framework.id,
    });
    expect(semesterThread.thread.lessonFileId).toBeUndefined();

    const starterResponse = await app.request(
      `/api/agent/threads/${semesterThread.thread.id}/starters`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-lessonup-user": userA },
        body: JSON.stringify({}),
      },
    );
    expect(starterResponse.status).toBe(200);
    await expect(starterResponse.json()).resolves.toMatchObject({
      starterSuggestions: [
        "检查2个单元的课时容量",
        "梳理当前单元的复习与铺垫",
      ],
      starterSuggestionsResourceVersion: 0,
    });

    const threadListResponse = await app.request(
      `/api/agent/threads?semesterFrameworkId=${created.framework.id}`,
      { headers: { "x-lessonup-user": userA } },
    );
    expect(threadListResponse.status).toBe(200);
    await expect(threadListResponse.json()).resolves.toHaveLength(1);

    const forbidden = await app.request(`/api/semester-frameworks/${created.framework.id}`, {
      headers: { "x-lessonup-user": userB },
    });
    expect(forbidden.status).toBe(404);
  });

  it("persists manual unit planning and lesson blueprints through aggregate versions", async () => {
    const repository = new MemoryLessonRepository();
    const app = createApp(repository, { harness: null });
    const userId = "00000000-0000-4000-8000-00000000000a";
    await repository.importNotebookGraph(userId, [{
      id: "n-planning",
      title: "七年级数学",
      className: "一班",
      year: "2026",
      subject: "数学",
      files: [],
    }]);
    const headers = { "content-type": "application/json", "x-lessonup-user": userId };
    const createdResponse = await app.request(
      "/api/notebooks/n-planning/semester-frameworks",
      {
        method: "POST",
        headers: { ...headers, "idempotency-key": "manual-planning-create" },
        body: JSON.stringify({
          textbookId: "textbook-math-bnu",
          title: "七年级数学上册教学框架",
          term: "上学期",
          startDate: null,
          totalWeeks: 18,
          weeklyPeriods: 5,
          lessonDurationMinutes: 40,
          capacityRatio: 0.9,
          planningHorizonWeeks: 2,
          contextProfile: {},
        }),
      },
    );
    const created = await createdResponse.json() as {
      framework: { id: string; version: number };
      units: Array<{ id: string; learningGoals: string }>;
    };
    const unit = created.units[0]!;
    const patchResponse = await app.request(`/api/semester-frameworks/${created.framework.id}`, {
      method: "PATCH",
      headers: { ...headers, "idempotency-key": "manual-planning-patch" },
      body: JSON.stringify({
        baseFrameworkVersion: created.framework.version,
        summary: "补充单元目标",
        operations: [{
          op: "replace_unit_field",
          unitId: unit.id,
          field: "learningGoals",
          expectedValue: "",
          replacement: "能够识别周期变化并解释重复规律",
        }],
      }),
    });
    expect(patchResponse.status).toBe(200);
    const patched = await patchResponse.json() as {
      framework: { version: number };
      units: Array<{ id: string; learningGoals: string }>;
    };
    expect(patched.framework.version).toBe(1);
    expect(patched.units.find((item) => item.id === unit.id)?.learningGoals)
      .toBe("能够识别周期变化并解释重复规律");

    const blueprintResponse = await app.request(
      `/api/semester-frameworks/${created.framework.id}/blueprints`,
      {
        method: "POST",
        headers: { ...headers, "idempotency-key": "manual-blueprint-create" },
        body: JSON.stringify({
          semesterUnitId: unit.id,
          curriculumNodeId: "ch1-1",
          title: "认识周期变化",
          mainActivity: "比较三组周期现象并归纳共同特征",
          observableProduct: "完成一张周期特征对照表",
          assessmentEvidence: "能够解释对照表中的重复规律",
          anticipatedDifficulties: [],
          plannedMinutes: 40,
          teacherNotes: "",
        }),
      },
    );
    expect(blueprintResponse.status).toBe(201);
    const withBlueprint = await blueprintResponse.json() as {
      framework: { version: number };
      blueprints: Array<{ id: string; title: string; version: number }>;
    };
    expect(withBlueprint.framework.version).toBe(2);
    expect(withBlueprint.blueprints[0]?.title).toBe("认识周期变化");

    const blueprint = withBlueprint.blueprints[0]!;
    const updateResponse = await app.request(
      `/api/semester-frameworks/${created.framework.id}/blueprints/${blueprint.id}`,
      {
        method: "PATCH",
        headers: { ...headers, "idempotency-key": "manual-blueprint-update" },
        body: JSON.stringify({
          expectedVersion: blueprint.version,
          status: "ready",
          mainActivity: "独立观察、同伴比较，再共同归纳周期特征",
        }),
      },
    );
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json() as {
      framework: { version: number };
      blueprints: Array<{ id: string; version: number; status: string; mainActivity: string }>;
    };
    expect(updated.framework.version).toBe(3);
    expect(updated.blueprints[0]).toMatchObject({
      status: "ready",
      mainActivity: "独立观察、同伴比较，再共同归纳周期特征",
    });

    const deleteResponse = await app.request(
      `/api/semester-frameworks/${created.framework.id}/blueprints/${updated.blueprints[0]!.id}`,
      {
        method: "DELETE",
        headers: { ...headers, "idempotency-key": "manual-blueprint-delete" },
        body: JSON.stringify({ expectedVersion: updated.blueprints[0]!.version }),
      },
    );
    expect(deleteResponse.status).toBe(200);
    const deleted = await deleteResponse.json() as {
      framework: { version: number };
      blueprints: unknown[];
    };
    expect(deleted.framework.version).toBe(4);
    expect(deleted.blueprints).toEqual([]);
  });

  it("refuses to stack another empty new thread on the current empty branch", async () => {
    const repository = new MemoryLessonRepository();
    const app = createApp(repository, { harness: null, threadStarterGenerator: null });
    const userId = "00000000-0000-4000-8000-00000000000a";
    await repository.importNotebookGraph(userId, [{
      id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
      files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
    }]);
    const current = await repository.createThread(userId, {
      notebookId: "n1", lessonFileId: "f1",
    });

    const response = await app.request("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userId },
      body: JSON.stringify({
        notebookId: "n1",
        lessonFileId: "f1",
        currentThreadId: current.thread.id,
        currentBranchId: current.branch.id,
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "current_thread_empty" });
    await expect(repository.listThreads(userId, "f1")).resolves.toHaveLength(1);
  });

  it("generates starters asynchronously from the canonical document without adding conversation history", async () => {
    const repository = new MemoryLessonRepository();
    const app = createApp(repository, {
      harness: null,
      threadStarterGenerator: async ({ file }) => [
        `检查${file?.document.topic}的目标一致性`,
        "优化课堂问题链",
      ],
    });
    const userId = "00000000-0000-4000-8000-00000000000a";
    await repository.importNotebookGraph(userId, [{
      id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
      files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
    }]);

    const response = await app.request("/api/agent/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userId },
      body: JSON.stringify({ notebookId: "n1", lessonFileId: "f1" }),
    });

    expect(response.status).toBe(201);
    const created = await response.json() as {
      thread: { id: string; starterSuggestions: string[]; starterSuggestionsDocumentVersion: number };
      branch: { id: string };
    };
    expect(created.thread.starterSuggestions).toEqual([]);

    const starterResponse = await app.request(`/api/agent/threads/${created.thread.id}/starters`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lessonup-user": userId },
      body: JSON.stringify({}),
    });
    expect(starterResponse.status).toBe(200);
    const thread = await starterResponse.json() as {
      id: string;
      starterSuggestions: string[];
      starterSuggestionsDocumentVersion: number;
    };
    expect(thread.starterSuggestions).toEqual([
      "检查课题的目标一致性",
      "优化课堂问题链",
    ]);
    expect(thread.starterSuggestionsDocumentVersion).toBe(0);
    await expect(repository.listMessages(
      userId,
      thread.id,
      created.branch.id,
    )).resolves.toEqual([]);
  });

  it("restores only normalized activity from the latest run in the selected branch", async () => {
    const repository = new MemoryLessonRepository();
    const userId = "00000000-0000-4000-8000-00000000000a";
    await repository.importNotebookGraph(userId, [{
      id: "n1", title: "备课本", className: "一班", year: "2026", subject: "数学",
      files: [{ id: "f1", title: "课题", type: "概念课", pages: 1, lessonPlan: document }],
    }]);
    const { thread, branch } = await repository.createThread(userId, {
      notebookId: "n1", lessonFileId: "f1",
    });
    await repository.createRun({
      id: "00000000-0000-4000-8000-0000000000aa",
      ownerId: userId,
      threadId: thread.id,
      branchId: branch.id,
      model: "test",
      status: "completed",
    });
    await repository.appendRunEvent(userId, "00000000-0000-4000-8000-0000000000aa", "tool.started", {
      type: "tool.started",
      runId: "00000000-0000-4000-8000-0000000000aa",
      toolCallId: "call-1",
      name: "read_document",
      label: "读取整份教案",
      groupKey: "document-read",
    });
    const app = createApp(repository, { harness: null });
    const response = await app.request(
      `/api/agent/threads/${thread.id}/activity?branchId=${branch.id}`,
      { headers: { "x-lessonup-user": userId } },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { run: { id: string }; events: Array<{ type: string }> };
    expect(payload.run.id).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(payload.events).toEqual([expect.objectContaining({ type: "tool.started" })]);
  });
});
