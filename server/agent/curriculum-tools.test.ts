import { describe, expect, it } from "vitest";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { createCurriculumTools } from "./curriculum-tools.js";

describe("createCurriculumTools", () => {
  it("looks up textbooks and reads outlines from the repository", async () => {
    const repository = new MemoryLessonRepository();
    const userId = "00000000-0000-4000-8000-000000000001";
    const runId = "00000000-0000-4000-8000-000000000002";
    await repository.createRun({
      id: runId,
      ownerId: userId,
      threadId: "thread",
      branchId: "branch",
      model: "test",
      status: "running",
    });
    const [lookup, searchNodes, readOutline] = createCurriculumTools(repository);
    const runContext = { context: { userId, runId } } as never;

    const lookupResult = JSON.parse(String(await lookup.invoke(
      runContext,
      JSON.stringify({ subject: "信息技术", stage: "高中" }),
    )));
    expect(lookupResult.count).toBe(1);
    expect(lookupResult.textbooks[0].id).toBe("textbook-it-3d");

    const searchResult = JSON.parse(String(await searchNodes.invoke(
      runContext,
      JSON.stringify({ query: "周期变化" }),
    )));
    expect(searchResult.matches[0].path.map((node: { title: string }) => node.title))
      .toEqual(["第一章 三角函数", "1 周期变化"]);

    const outlineResult = JSON.parse(String(await readOutline.invoke(
      runContext,
      JSON.stringify({ textbookId: "textbook-it-3d", maxLevel: 2 }),
    )));
    expect(outlineResult.textbook.title).toContain("三维设计与创意");
    expect(outlineResult.outline.some((row: { title: string }) => (
      row.title.includes("第1单元")
    ))).toBe(true);
    expect(outlineResult.outline.some((row: { title: string }) => (
      row.title.includes("1.1")
    ))).toBe(true);
    const evidence = await repository.listRunEvidence(userId, runId);
    expect(evidence.map((record) => record.kind)).toEqual(expect.arrayContaining([
      "curriculum_textbook",
      "curriculum_outline",
    ]));
  });

  it("expands a parent node as a non-empty subtree", async () => {
    const repository = new MemoryLessonRepository();
    const userId = "00000000-0000-4000-8000-000000000003";
    const runId = "00000000-0000-4000-8000-000000000004";
    await repository.createRun({
      id: runId, ownerId: userId, threadId: "thread", branchId: "branch",
      model: "test", status: "running",
    });
    const readOutline = createCurriculumTools(repository)[2]!;
    const result = JSON.parse(String(await readOutline.invoke(
      { context: { userId, runId } } as never,
      JSON.stringify({ textbookId: "textbook-math-bnu", parentId: "ch1", maxLevel: 3 }),
    )));
    expect(result.outline.map((row: { title: string }) => row.title)).toEqual([
      "1 周期变化",
      "  习题1-1",
    ]);
  });

  it("reads reviewed node semantics and traces their instructional continuity", async () => {
    const repository = new MemoryLessonRepository();
    const userId = "00000000-0000-4000-8000-000000000005";
    const runId = "00000000-0000-4000-8000-000000000006";
    await repository.createRun({
      id: runId, ownerId: userId, threadId: "thread", branchId: "branch",
      model: "test", status: "running",
    });
    const tools = createCurriculumTools(repository);
    const runContext = { context: { userId, runId } } as never;

    const semanticResult = JSON.parse(String(await tools[3]!.invoke(
      runContext,
      JSON.stringify({ textbookId: "textbook-math-bnu", nodeId: "ch1-1" }),
    )));
    expect(semanticResult.status).toBe("available");
    expect(semanticResult.semantics).toEqual([
      expect.objectContaining({
        name: "周期变化",
        instructionalRole: "introduces",
      }),
    ]);

    const pathResult = JSON.parse(String(await tools[4]!.invoke(
      runContext,
      JSON.stringify({
        entityId: semanticResult.semantics[0].entityId,
        direction: "forward",
      }),
    )));
    expect(pathResult.steps).toEqual([
      expect.objectContaining({
        from: "周期变化",
        to: "三角函数",
        locations: [expect.objectContaining({ node: "第一章 三角函数" })],
      }),
    ]);
    const backwardResult = JSON.parse(String(await tools[4]!.invoke(
      runContext,
      JSON.stringify({
        entityId: "00000000-0000-4000-8000-000000000402",
        direction: "backward",
      }),
    )));
    expect(backwardResult.steps).toEqual([
      expect.objectContaining({
        reached: "周期变化",
        locations: [expect.objectContaining({ node: "1 周期变化" })],
      }),
    ]);
    await expect(repository.listRunEvidence(userId, runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "curriculum_semantics" }),
      ]),
    );
  });

  it("reads uniform knowledge points and keeps sequence-based continuity as candidates", async () => {
    const repository = new MemoryLessonRepository();
    const userId = "00000000-0000-4000-8000-000000000007";
    const runId = "00000000-0000-4000-8000-000000000008";
    await repository.createRun({
      id: runId, ownerId: userId, threadId: "thread", branchId: "branch",
      model: "test", status: "running",
    });
    const tools = createCurriculumTools(repository);
    const runContext = {
      context: { userId, runId, abortSignal: new AbortController().signal },
    } as never;

    const nodeResult = JSON.parse(String(await tools[5]!.invoke(
      runContext,
      JSON.stringify({ textbookId: "textbook-math-bnu", nodeId: "ch1-1" }),
    )));
    expect(nodeResult.status).toBe("available");
    expect(nodeResult.points).toEqual([
      expect.objectContaining({ name: "周期变化", recommendedPeriod: 1 }),
    ]);
    expect(nodeResult.periodRecommendations[0]).toEqual(expect.objectContaining({
      isOfficial: false,
    }));

    const searchResult = JSON.parse(String(await tools[6]!.invoke(
      runContext,
      JSON.stringify({
        textbookId: "textbook-math-bnu", currentNodeId: "ch1", query: "周期变化",
      }),
    )));
    expect(searchResult.results[0]).toEqual(expect.objectContaining({
      name: "周期变化",
      occurrences: [expect.objectContaining({ node: "1 周期变化", position: "before" })],
    }));

    const continuityResult = JSON.parse(String(await tools[7]!.invoke(
      runContext,
      JSON.stringify({
        textbookId: "textbook-math-bnu",
        currentNodeId: "ch1",
        entityId: "00000000-0000-4000-8000-000000000402",
      }),
    )));
    expect(continuityResult.candidates[0]).toEqual(expect.objectContaining({
      name: "周期变化",
      occurrences: [expect.objectContaining({ position: "before" })],
    }));
    expect(continuityResult.inferenceBoundary).toContain("不是已确认的先修关系");
    await expect(repository.listRunEvidence(userId, runId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "curriculum_knowledge" })]),
    );
  });

  it("reads knowledge points from the current lesson scope without exposing routing IDs", async () => {
    const repository = new MemoryLessonRepository();
    const userId = "00000000-0000-4000-8000-000000000009";
    const runId = "00000000-0000-4000-8000-000000000010";
    await repository.createRun({
      id: runId, ownerId: userId, threadId: "thread", branchId: "branch",
      model: "test", status: "running",
    });
    const readKnowledge = createCurriculumTools(repository)[5]!;
    const result = JSON.parse(String(await readKnowledge.invoke({
      context: {
        userId,
        runId,
        resourceType: "lesson_file",
        contextProfile: {
          textbookId: "textbook-math-bnu",
          lessonNodeId: "ch1-1",
        },
      },
    } as never, JSON.stringify({}))));

    expect(result).toMatchObject({
      status: "available",
      node: { title: "1 周期变化" },
      points: [expect.objectContaining({ name: "周期变化" })],
    });
  });
});
