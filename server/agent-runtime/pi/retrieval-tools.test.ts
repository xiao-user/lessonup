import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeResult, PreparationAgentContext } from "../../domain.js";
import { MemoryLessonRepository } from "../../repositories/memory-repository.js";
import type { LessonRepository } from "../../repository.js";
import { createPiCurriculumTools } from "./curriculum-tools.js";
import { createPiLessonKnowledgeTools } from "./lesson-tools.js";

const ownerId = "00000000-0000-4000-8000-00000000000a";
const runId = "00000000-0000-4000-8000-00000000000b";
const standard: KnowledgeResult = {
  id: "standard-1", title: "义务教育数学课程标准", kind: "public", passage: "理解负数的意义。", score: 1, section: "四、课程内容",
};

function toolNamed(tools: AgentTool<any>[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

const textOf = (result: AgentToolResult<unknown>) => result.content
  .map((part) => (part.type === "text" ? part.text : ""))
  .join("");

async function curriculumFixture() {
  const repository: LessonRepository = new MemoryLessonRepository();
  const notebook = await repository.createNotebook(ownerId, {
    title: "七年级数学", className: "一班", year: "2026", subject: "数学", stage: "初中", grade: "七年级", edition: "人教版", tone: "teal",
  });
  const searches: Array<Parameters<LessonRepository["searchCurriculumStandards"]>[0]> = [];
  repository.searchCurriculumStandards = async (input) => { searches.push(input); return [standard]; };
  const evidence: Array<{ kind: string; sources: KnowledgeResult[] }> = [];
  repository.recordRunEvidence = async (_owner, _run, kind, sources) => { evidence.push({ kind, sources: sources as KnowledgeResult[] }); };
  const context = { userId: ownerId, notebookId: notebook.id, runId, contextProfile: {}, abortSignal: new AbortController().signal } as unknown as PreparationAgentContext;
  return { repository, context, searches, evidence };
}

describe("native retrieval tools", () => {
  it("embeds a knowledge query and passes the vector to the search", async () => {
    const repository = new MemoryLessonRepository();
    const search = vi.fn(async () => [] as KnowledgeResult[]);
    repository.searchKnowledge = search;
    repository.recordRunEvidence = async () => undefined;
    const embed = vi.fn(async () => [0.5, 0.5]);
    const tool = toolNamed(createPiLessonKnowledgeTools(repository, {
      ownerId, notebookId: "n1", lessonFileId: "f1", runId, allowedKnowledgeScopes: ["public"],
    }, embed), "search_knowledge");
    const signal = new AbortController().signal;
    await tool.execute("call-1", { query: "板书设计", limit: 4 }, signal);
    expect(embed).toHaveBeenCalledWith("板书设计", signal);
    expect(search).toHaveBeenCalledWith(ownerId, ["public"], "板书设计", 4, [0.5, 0.5]);
  });

  it("still searches by text when the embedding service is missing or fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const embed of [undefined, async () => { throw new Error("embedding_failed:503"); }]) {
        const repository = new MemoryLessonRepository();
        const search = vi.fn(async () => [{ id: "s1", title: "资料", kind: "private", passage: "原文", score: 1 }] as KnowledgeResult[]);
        repository.searchKnowledge = search;
        repository.recordRunEvidence = async () => undefined;
        const tool = toolNamed(createPiLessonKnowledgeTools(repository, {
          ownerId, notebookId: "n1", lessonFileId: "f1", runId, allowedKnowledgeScopes: ["public"],
        }, embed), "search_knowledge");
        const result = await tool.execute("call-1", { query: "板书设计" });
        expect(search).toHaveBeenCalledWith(ownerId, ["public"], "板书设计", 6, undefined);
        expect(textOf(result)).toContain("原文");
      }
      expect(warn).toHaveBeenCalledWith("Query embedding unavailable; using lexical retrieval", "embedding_failed:503");
    } finally {
      warn.mockRestore();
    }
  });

  it("searches the standards with a query vector and reuses the exact cached result", async () => {
    const { repository, context, searches, evidence } = await curriculumFixture();
    let embedded = 0;
    const embed = async () => { embedded += 1; return [1, 0, 0]; };
    const tool = toolNamed(createPiCurriculumTools(repository, context, embed), "search_curriculum_standards");
    const first = await tool.execute("call-1", { query: "理解负数的意义  并比较有理数" });
    const second = await tool.execute("call-2", { query: "  理解负数的意义 并比较有理数  " });
    expect(JSON.parse(textOf(first))).toEqual([standard]);
    expect(textOf(second)).toBe(textOf(first));
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({ subject: "数学", stage: "初中", grade: "七年级", limit: 6, embedding: [1, 0, 0] });
    expect(embedded).toBe(1);
    // Evidence is recorded for every call, including the one served from the cache.
    expect(evidence).toEqual([
      { kind: "curriculum_standard_search", sources: [standard] },
      { kind: "curriculum_standard_search", sources: [standard] },
    ]);
  });

  it("does not cache a standards result that was ranked without the vector it should have had", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { repository, context, searches } = await curriculumFixture();
      let failing = true;
      const embed = async () => { if (failing) throw new Error("embedding_failed:503"); return [1, 0, 0]; };
      const tool = toolNamed(createPiCurriculumTools(repository, context, embed), "search_curriculum_standards");
      await tool.execute("call-1", { query: "负数" });
      failing = false;
      await tool.execute("call-2", { query: "负数" });
      expect(searches.map((search) => search.embedding)).toEqual([undefined, [1, 0, 0]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("caches a lexical-only standards result separately from a vector-ranked one", async () => {
    const { repository, context, searches } = await curriculumFixture();
    const lexical = toolNamed(createPiCurriculumTools(repository, context), "search_curriculum_standards");
    const semantic = toolNamed(createPiCurriculumTools(repository, context, async () => [1, 0, 0]), "search_curriculum_standards");
    await lexical.execute("call-1", { query: "负数" });
    await semantic.execute("call-2", { query: "负数" });
    expect(searches.map((search) => search.embedding)).toEqual([undefined, [1, 0, 0]]);
  });

  it("passes the query vector to the knowledge-point search", async () => {
    const { repository, context } = await curriculumFixture();
    const search = vi.fn(async () => []);
    repository.searchCurriculumKnowledgePoints = search;
    repository.recordRunEvidence = async () => undefined;
    const tool = toolNamed(createPiCurriculumTools(repository, context, async () => [0, 1]), "search_curriculum_knowledge_points");
    await tool.execute("call-1", { textbookId: "book-1", query: "比喻", limit: 5 });
    expect(search).toHaveBeenCalledWith({ textbookId: "book-1", query: "比喻", limit: 5, embedding: [0, 1] });
  });
});
