import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { formatCurriculumOutlineTree } from "../../curriculum/catalog.js";
import type {
  CurriculumSemanticSource,
  CurriculumTextbookRecord,
  PreparationAgentContext,
  SourceRef,
} from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { withoutInternalCurriculumAssetUrl } from "../../agent/source-policy.js";
import { searchScopedCurriculumStandards } from "../../curriculum/standard-search.js";
import { tryEmbedQuery, type QueryEmbedder } from "../../providers/query-embedding.js";

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: null,
});

const uniqueSources = (sources: CurriculumSemanticSource[]) => (
  [...new Map(sources.map((source) => [source.id, source])).values()]
    .map(withoutInternalCurriculumAssetUrl)
);

const textbookSource = (book: CurriculumTextbookRecord, page?: number | null, suffix = "目录"): SourceRef => ({
  id: `curriculum:${book.id}:${suffix}:${page ?? "all"}`,
  title: `${book.title}（国家智慧教育平台${suffix}）`,
  kind: "public",
  page: page ?? undefined,
});

export function createPiCurriculumTools(
  repository: LessonRepository,
  context: PreparationAgentContext,
  embedQuery?: QueryEmbedder,
): AgentTool<any>[] {
  const record = async (kind: Parameters<LessonRepository["recordRunEvidence"]>[2], sources: SourceRef[]) => {
    await repository.recordRunEvidence(context.userId, context.runId, kind, sources);
  };

  const lookup: AgentTool<any> = {
    name: "lookup_curriculum_textbooks",
    label: "查找教材书目",
    description: "按学段、学科、版本、年级或关键词查找官方教材书目。",
    parameters: Type.Object({
      stage: Type.Optional(Type.String({ maxLength: 40 })),
      subject: Type.Optional(Type.String({ maxLength: 40 })),
      edition: Type.Optional(Type.String({ maxLength: 40 })),
      grade: Type.Optional(Type.String({ maxLength: 40 })),
      query: Type.Optional(Type.String({ maxLength: 80 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const books = await repository.searchCurriculumTextbooks(input as any);
      const sources = books.map((book) => textbookSource(book, null, "教材信息"));
      await record("curriculum_textbook", sources);
      return textResult({ count: books.length, textbooks: books, sources });
    },
  };

  const searchStandards: AgentTool<any> = {
    name: "search_curriculum_standards",
    label: "检索当前学科课标",
    description: "检索当前备课本学科范围内已发布的国家课程标准片段。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 300 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input, signal) => {
      const args = input as { query: string; limit?: number };
      const { results } = await searchScopedCurriculumStandards({
        repository,
        scope: { userId: context.userId, notebookId: context.notebookId, runId: context.runId },
        query: args.query,
        limit: args.limit ?? 6,
        embed: embedQuery ? (query) => embedQuery(query, signal) : undefined,
      });
      return textResult(results);
    },
  };

  const searchNodes: AgentTool<any> = {
    name: "search_curriculum_nodes",
    label: "检索教材篇目",
    description: "按篇目、单元或章节标题检索官方教材目录；目录不等于教材正文。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 120 }),
      textbookId: Type.Optional(Type.String({ maxLength: 80 })),
      subject: Type.Optional(Type.String({ maxLength: 40 })),
      stage: Type.Optional(Type.String({ maxLength: 40 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const matches = await repository.searchCurriculumNodes(input as any);
      const sources = matches.map((match) => textbookSource(match.textbook, match.node.pageNumber));
      await record("curriculum_outline", sources);
      return textResult({ count: matches.length, matches, sources });
    },
  };

  const outline: AgentTool<any> = {
    name: "read_curriculum_outline",
    label: "读取教材目录",
    description: "读取指定教材的官方章节目录树与页码。",
    parameters: Type.Object({
      textbookId: Type.String({ minLength: 1, maxLength: 80 }),
      parentId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 80 }), Type.Null()])),
      maxLevel: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const args = input as { textbookId: string; parentId?: string | null; maxLevel?: number };
      const book = await repository.getCurriculumTextbook(args.textbookId);
      if (!book) throw new Error("curriculum_textbook_not_found");
      const nodes = await repository.listCurriculumNodes(args);
      const sources = nodes.length ? [textbookSource(book)] : [];
      await record("curriculum_outline", sources);
      return textResult({
        textbook: book,
        outline: formatCurriculumOutlineTree(nodes, { rootParentId: args.parentId ?? null }),
        sources,
      });
    },
  };

  const semantics: AgentTool<any> = {
    name: "read_curriculum_node_semantics",
    label: "读取章节学习要点",
    description: "读取平台已发布且有来源的章节知识点、能力点和教学角色。",
    parameters: Type.Object({
      textbookId: Type.String({ minLength: 1, maxLength: 80 }),
      nodeId: Type.String({ minLength: 1, maxLength: 80 }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const result = await repository.readCurriculumNodeSemantics(input as any);
      const sources = uniqueSources(result.mappings.flatMap((mapping) => [
        ...mapping.sources,
        ...mapping.entity.sources,
      ]));
      await record("curriculum_semantics", sources);
      return textResult({
        status: result.release && result.mappings.length ? "available" : "unavailable",
        release: result.release,
        semantics: result.mappings,
        sources,
      });
    },
  };

  const knowledge: AgentTool<any> = {
    name: "read_curriculum_knowledge_points",
    label: "读取章节知识点",
    description: "读取当前教案绑定章节或显式指定章节的已发布知识点和课时建议。",
    parameters: Type.Object({
      textbookId: Type.Optional(Type.String({ maxLength: 80 })),
      nodeId: Type.Optional(Type.String({ maxLength: 80 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const requested = input as { textbookId?: string; nodeId?: string };
      const profile = context.contextProfile as {
        textbookId?: string;
        lessonNodeId?: string;
        unitNodeId?: string;
      };
      const textbookId = requested.textbookId ?? profile.textbookId;
      const nodeId = requested.nodeId ?? profile.lessonNodeId ?? profile.unitNodeId;
      if (!textbookId || !nodeId) throw new Error("current_curriculum_context_missing");
      const result = await repository.readCurriculumNodeKnowledgePoints({ textbookId, nodeId });
      const sources = uniqueSources(result.points.flatMap((item) => item.point.sources));
      await record("curriculum_knowledge", sources);
      return textResult({
        status: result.release && result.points.length ? "available" : "unavailable",
        points: result.points,
        periodRecommendations: result.periodRecommendations,
        sources,
      });
    },
  };

  const searchKnowledge: AgentTool<any> = {
    name: "search_curriculum_knowledge_points",
    label: "检索相关知识点",
    description: "在一本教材的已发布知识点网络中检索候选关联；相似度不代表已确认先修关系。",
    parameters: Type.Object({
      textbookId: Type.String({ minLength: 1, maxLength: 80 }),
      query: Type.String({ minLength: 1, maxLength: 200 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input, signal) => {
      const args = input as { textbookId: string; query: string; limit?: number };
      const { vector } = await tryEmbedQuery(embedQuery, args.query, signal);
      const result = await repository.searchCurriculumKnowledgePoints({ ...args, embedding: vector });
      const sources = uniqueSources(result.flatMap((item) => item.point.sources));
      await record("curriculum_knowledge", sources);
      return textResult({ results: result, sources, inferenceBoundary: "仅为候选关联。" });
    },
  };

  const continuity: AgentTool<any> = {
    name: "read_curriculum_knowledge_continuity",
    label: "核对知识连续性",
    description: "读取当前章节某知识点在同册教材中的前后候选位置。",
    parameters: Type.Object({
      textbookId: Type.String({ minLength: 1, maxLength: 80 }),
      currentNodeId: Type.String({ minLength: 1, maxLength: 80 }),
      entityId: Type.String({ format: "uuid" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const result = await repository.readCurriculumKnowledgeContinuity(input as any);
      const sources = uniqueSources([
        ...(result.target?.sources ?? []),
        ...result.candidates.flatMap((candidate) => candidate.point.sources),
      ]);
      await record("curriculum_knowledge", sources);
      return textResult({ ...result, sources, inferenceBoundary: "位置和相似度只用于召回候选。" });
    },
  };

  return [
    lookup,
    searchStandards,
    searchNodes,
    outline,
    semantics,
    knowledge,
    searchKnowledge,
    continuity,
  ];
}
