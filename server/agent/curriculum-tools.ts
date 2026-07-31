import { tool } from "@openai/agents";
import { z } from "zod";
import { formatCurriculumOutlineTree } from "../curriculum/catalog.js";
import type {
  CurriculumTextbookRecord,
  LessonAgentContext,
  SourceRef,
} from "../domain.js";
import type { LessonRepository } from "../repository.js";

const requireContext = (context?: { context: unknown }) => {
  if (!context?.context) throw new Error("agent_context_missing");
  return context.context as LessonAgentContext;
};

const textbookSource = (
  book: CurriculumTextbookRecord,
  page?: number | null,
  suffix = "目录",
): SourceRef => ({
  id: `curriculum:${book.id}:${suffix}:${page ?? "all"}`,
  title: `${book.title}（国家智慧教育平台${suffix}）`,
  url: book.treeUrl ?? book.detailUrl ?? undefined,
  kind: "public",
  page: page ?? undefined,
});

export function createCurriculumTools(repository: LessonRepository) {
  const lookupCurriculumTextbooks = tool({
    name: "lookup_curriculum_textbooks",
    description: "按学段、学科、版本、年级或关键词查找国家智慧教育平台教材书目。返回教材 ID 与元数据，不含正文。需要目录时再用 read_curriculum_outline。",
    parameters: z.object({
      stage: z.string().trim().min(1).max(40).nullable().optional(),
      subject: z.string().trim().min(1).max(40).nullable().optional(),
      edition: z.string().trim().min(1).max(40).nullable().optional(),
      grade: z.string().trim().min(1).max(40).nullable().optional(),
      query: z.string().trim().min(1).max(80).nullable().optional(),
      limit: z.number().int().min(1).max(200).nullable().optional(),
    }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const books = await repository.searchCurriculumTextbooks({
        stage: input.stage ?? undefined,
        subject: input.subject ?? undefined,
        edition: input.edition ?? undefined,
        grade: input.grade ?? undefined,
        query: input.query ?? undefined,
        limit: input.limit ?? undefined,
      });
      const sources = books.map((book) => textbookSource(book, null, "教材信息"));
      if (sources.length) {
        await repository.recordRunEvidence(
          context.userId,
          context.runId,
          "curriculum_textbook",
          sources,
        );
      }
      return JSON.stringify({
        count: books.length,
        textbooks: books.map((book) => ({
          id: book.id,
          title: book.title,
          stage: book.stage,
          subject: book.subject,
          edition: book.edition,
          grade: book.grade,
          volume: book.volume,
          nodeCount: book.nodeCount,
        })),
        sources,
      });
    },
  });

  const searchCurriculumNodes = tool({
    name: "search_curriculum_nodes",
    description: "按课文、篇目、单元或章节标题检索国家智慧教育平台官方教材目录。适合查询“《春》在哪本教材、哪个单元、哪一页”。只证明目录结构与页码，不证明教材正文内容。",
    parameters: z.object({
      query: z.string().trim().min(1).max(120),
      textbookId: z.string().trim().min(1).max(80).nullable().optional(),
      subject: z.string().trim().min(1).max(40).nullable().optional(),
      stage: z.string().trim().min(1).max(40).nullable().optional(),
      limit: z.number().int().min(1).max(50).nullable().optional(),
    }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const matches = await repository.searchCurriculumNodes({
        query: input.query,
        textbookId: input.textbookId ?? undefined,
        subject: input.subject ?? undefined,
        stage: input.stage ?? undefined,
        limit: input.limit ?? undefined,
      });
      const sources = matches.map((match) => (
        textbookSource(match.textbook, match.node.pageNumber, "目录")
      ));
      if (sources.length) {
        await repository.recordRunEvidence(
          context.userId,
          context.runId,
          "curriculum_outline",
          sources,
        );
      }
      return JSON.stringify({
        count: matches.length,
        matches: matches.map((match) => ({
          textbook: {
            id: match.textbook.id,
            title: match.textbook.title,
            stage: match.textbook.stage,
            subject: match.textbook.subject,
            edition: match.textbook.edition,
            grade: match.textbook.grade,
            volume: match.textbook.volume,
          },
          node: {
            nodeId: match.node.nodeId,
            title: match.node.title,
            pageNumber: match.node.pageNumber,
          },
          path: match.path.map((node) => ({
            nodeId: node.nodeId,
            title: node.title,
            pageNumber: node.pageNumber,
          })),
        })),
        sources,
      });
    },
  });

  const readCurriculumOutline = tool({
    name: "read_curriculum_outline",
    description: "读取指定教材的官方章节目录树（单元/课/节）与页码。textbookId 可来自教材查找或当前教案已验证的教材上下文。默认返回前三级；指定 parentId 时返回该节点下的完整子树。",
    parameters: z.object({
      textbookId: z.string().trim().min(1).max(80),
      parentId: z.string().trim().min(1).max(80).nullable().optional(),
      maxLevel: z.number().int().min(1).max(5).nullable().optional(),
    }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const book = await repository.getCurriculumTextbook(input.textbookId);
      if (!book) throw new Error("curriculum_textbook_not_found");
      const nodes = await repository.listCurriculumNodes({
        textbookId: input.textbookId,
        parentId: input.parentId === undefined ? undefined : (input.parentId || null),
        maxLevel: input.maxLevel ?? 3,
      });
      const sources = nodes.length ? [textbookSource(book)] : [];
      if (sources.length) {
        await repository.recordRunEvidence(
          context.userId,
          context.runId,
          "curriculum_outline",
          sources,
        );
      }
      return JSON.stringify({
        textbook: {
          id: book.id,
          title: book.title,
          stage: book.stage,
          subject: book.subject,
          edition: book.edition,
          grade: book.grade,
          volume: book.volume,
          nodeCount: book.nodeCount,
        },
        outline: formatCurriculumOutlineTree(nodes, {
          rootParentId: input.parentId ?? null,
        }),
        sources,
      });
    },
  });

  return [lookupCurriculumTextbooks, searchCurriculumNodes, readCurriculumOutline];
}
