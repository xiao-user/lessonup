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
});
