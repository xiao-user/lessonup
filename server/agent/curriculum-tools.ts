import { tool } from "@openai/agents";
import { z } from "zod";
import { formatCurriculumOutlineTree } from "../curriculum/catalog.js";
import type {
  CurriculumSemanticSource,
  CurriculumTextbookRecord,
  PreparationAgentContext,
  SourceRef,
} from "../domain.js";
import { BgeM3EmbeddingProvider } from "../providers/embeddings.js";
import type { LessonRepository } from "../repository.js";
import { withoutInternalCurriculumAssetUrl } from "./source-policy.js";

const uniqueSources = (sources: CurriculumSemanticSource[]) => (
  [...new Map(sources.map((source) => [source.id, source])).values()]
    .map(withoutInternalCurriculumAssetUrl)
);

const requireContext = (context?: { context: unknown }) => {
  if (!context?.context) throw new Error("agent_context_missing");
  return context.context as PreparationAgentContext;
};

const textbookSource = (
  book: CurriculumTextbookRecord,
  page?: number | null,
  suffix = "目录",
): SourceRef => ({
  id: `curriculum:${book.id}:${suffix}:${page ?? "all"}`,
  title: `${book.title}（国家智慧教育平台${suffix}）`,
  kind: "public",
  page: page ?? undefined,
});

export function createCurriculumTools(
  repository: LessonRepository,
  options: { currentLessonScopeOnly?: boolean } = {},
) {
  const embeddings = new BgeM3EmbeddingProvider();
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

  const readCurriculumNodeSemantics = tool({
    name: "read_curriculum_node_semantics",
    description: "读取平台已发布、已审核且有来源支撑的章节知识点、能力点、学习成果与教学角色。用于判断本章应复习什么、发展什么以及为后续什么内容铺垫。若没有已发布语义，返回 unavailable；不得根据目录标题自行补写为确定事实。",
    parameters: z.object({
      textbookId: z.string().trim().min(1).max(80),
      nodeId: z.string().trim().min(1).max(80),
    }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const book = await repository.getCurriculumTextbook(input.textbookId);
      if (!book) throw new Error("curriculum_textbook_not_found");
      const nodes = await repository.listCurriculumNodes({
        textbookId: input.textbookId,
        maxLevel: 8,
      });
      const node = nodes.find((candidate) => candidate.nodeId === input.nodeId);
      if (!node) throw new Error("curriculum_node_not_found");
      const semantics = await repository.readCurriculumNodeSemantics(input);
      const sources = uniqueSources(semantics.mappings.flatMap((mapping) => [
        ...mapping.sources,
        ...mapping.entity.sources,
      ]));
      if (sources.length) {
        await repository.recordRunEvidence(
          context.userId,
          context.runId,
          "curriculum_semantics",
          sources,
        );
      }
      return JSON.stringify({
        status: semantics.release && semantics.mappings.length ? "available" : "unavailable",
        textbook: {
          title: book.title,
          stage: book.stage,
          subject: book.subject,
          edition: book.edition,
          grade: book.grade,
          volume: book.volume,
        },
        node: { title: node.title, pageNumber: node.pageNumber },
        release: semantics.release,
        semantics: semantics.mappings.map((mapping) => ({
          entityId: mapping.entity.id,
          kind: mapping.entity.kind,
          name: mapping.entity.canonicalName,
          definition: mapping.entity.definition,
          instructionalRole: mapping.instructionalRole,
          expectedDepth: mapping.expectedDepth,
          priority: mapping.priority,
          confidence: Math.min(mapping.confidence, mapping.entity.confidence),
          rationale: mapping.rationale,
        })),
        sources,
      });
    },
  });

  const traceCurriculumLearningPath = tool({
    name: "trace_curriculum_learning_path",
    description: "沿平台已发布的语义关系追溯旧知或查看后续学习路径，并返回相关教材章节。先用 read_curriculum_node_semantics 获得 entityId。backward 用于复习旧知，forward 用于设计后续铺垫。只返回已审核且有来源的关系。",
    parameters: z.object({
      entityId: z.string().uuid(),
      direction: z.enum(["backward", "forward"]),
      relationTypes: z.array(z.enum([
        "part_of",
        "prerequisite",
        "supports",
        "develops_into",
        "contrasts_with",
        "often_confused_with",
        "transfers_to",
      ])).min(1).max(7).nullable().optional(),
      maxDepth: z.number().int().min(1).max(6).nullable().optional(),
    }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const entity = await repository.getCurriculumSemanticEntity(input.entityId);
      if (!entity) throw new Error("curriculum_semantic_entity_not_found");
      const steps = await repository.traceCurriculumSemanticPath({
        entityId: input.entityId,
        direction: input.direction,
        relationTypes: input.relationTypes ?? undefined,
        maxDepth: input.maxDepth ?? undefined,
      });
      const sources = uniqueSources([
        ...entity.sources,
        ...steps.flatMap((step) => [
          ...step.sources,
          ...step.fromEntity.sources,
          ...step.toEntity.sources,
        ]),
      ]);
      if (sources.length) {
        await repository.recordRunEvidence(
          context.userId,
          context.runId,
          "curriculum_semantics",
          sources,
        );
      }
      return JSON.stringify({
        start: { name: entity.canonicalName, kind: entity.kind },
        direction: input.direction,
        steps: steps.map((step) => ({
          depth: step.depth,
          relationType: step.relationType,
          from: step.fromEntity.canonicalName,
          to: step.toEntity.canonicalName,
          reached: step.reachedEntity.canonicalName,
          rationale: step.rationale,
          confidence: step.confidence,
          locations: step.locations.map((location) => ({
            textbook: location.textbook.title,
            grade: location.textbook.grade,
            volume: location.textbook.volume,
            node: location.node.title,
            pageNumber: location.node.pageNumber,
            instructionalRole: location.instructionalRole,
            expectedDepth: location.expectedDepth,
          })),
        })),
        sources,
      });
    },
  });

  const readCurriculumKnowledgePoints = tool({
    name: "read_curriculum_knowledge_points",
    description: options.currentLessonScopeOnly
      ? "读取当前教案已绑定章节的已发布统一知识点和非官方课时建议。无需提供教材或章节参数；若返回 unavailable，直接如实降级，不要尝试猜测内部编号。"
      : "读取当前教案绑定章节（也可显式指定教材章节）已发布、可追溯的统一知识点，以及非官方课时建议。知识点名称不预先强制拆分为能力点或方法点；需要时由你结合具体任务解释。课时建议只用于规划参考，不能表述为教材规定。",
    parameters: options.currentLessonScopeOnly
      ? z.object({})
      : z.object({
          textbookId: z.string().trim().min(1).max(80).nullable().optional(),
          nodeId: z.string().trim().min(1).max(80).nullable().optional(),
        }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const requested = input as { textbookId?: string | null; nodeId?: string | null };
      const currentProfile = context.resourceType === "semester_framework"
        ? undefined
        : context.contextProfile;
      const textbookId = requested.textbookId ?? currentProfile?.textbookId;
      const nodeId = requested.nodeId
        ?? currentProfile?.lessonNodeId
        ?? currentProfile?.unitNodeId;
      if (!textbookId || !nodeId) throw new Error("current_curriculum_context_missing");
      const book = await repository.getCurriculumTextbook(textbookId);
      if (!book) throw new Error("curriculum_textbook_not_found");
      const nodes = await repository.listCurriculumNodes({ textbookId, maxLevel: 8 });
      const node = nodes.find((candidate) => candidate.nodeId === nodeId);
      if (!node) throw new Error("curriculum_node_not_found");
      const record = await repository.readCurriculumNodeKnowledgePoints({ textbookId, nodeId });
      const sources = uniqueSources(record.points.flatMap((item) => item.point.sources));
      if (sources.length) {
        await repository.recordRunEvidence(
          context.userId,
          context.runId,
          "curriculum_knowledge",
          sources,
        );
      }
      return JSON.stringify({
        status: record.release && record.points.length ? "available" : "unavailable",
        textbook: {
          title: book.title,
          stage: book.stage,
          subject: book.subject,
          edition: book.edition,
          grade: book.grade,
          volume: book.volume,
        },
        node: { title: node.title, pageNumber: node.pageNumber },
        points: record.points.map((item) => ({
          entityId: item.point.id,
          name: item.point.canonicalName,
          detail: item.point.definition,
          sequenceNo: item.sequenceNo,
          printedPages: item.printedPages,
          recommendedPeriod: item.recommendedPeriod,
          evidenceAnchor: item.point.payload.evidenceAnchor,
          evidenceLevel: item.point.payload.evidenceLevel,
        })),
        periodRecommendations: record.periodRecommendations.map((period) => ({
          periodNo: period.periodNo,
          title: period.title,
          pointIds: period.pointIds,
          isOfficial: period.isOfficial,
          note: period.note,
        })),
        sources,
      });
    },
  });

  const searchCurriculumKnowledgePoints = tool({
    name: "search_curriculum_knowledge_points",
    description: "在一本教材的已发布知识点网络中检索相同或语义相关的知识点及其章节出现位置。传 currentNodeId 时会按目录顺序标注 before/current/after。用于发现候选关联，不代表这些知识点天然存在先修关系。",
    parameters: z.object({
      textbookId: z.string().trim().min(1).max(80),
      currentNodeId: z.string().trim().min(1).max(80).nullable().optional(),
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(20).nullable().optional(),
    }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const book = await repository.getCurriculumTextbook(input.textbookId);
      if (!book) throw new Error("curriculum_textbook_not_found");
      let embedding: number[] | undefined;
      try {
        [embedding] = await embeddings.embed([input.query], context.abortSignal);
      } catch {
        embedding = undefined;
      }
      const results = await repository.searchCurriculumKnowledgePoints({
        textbookId: input.textbookId,
        query: input.query,
        embedding,
        limit: input.limit ?? undefined,
      });
      const current = input.currentNodeId
        ? await repository.readCurriculumNodeKnowledgePoints({
          textbookId: input.textbookId,
          nodeId: input.currentNodeId,
        })
        : null;
      const currentSequenceNo = current?.points[0]?.sequenceNo;
      const sources = uniqueSources(results.flatMap((result) => result.point.sources));
      if (sources.length) {
        await repository.recordRunEvidence(
          context.userId,
          context.runId,
          "curriculum_knowledge",
          sources,
        );
      }
      return JSON.stringify({
        query: input.query,
        semanticSearchAvailable: embedding !== undefined,
        currentSequenceNo,
        results: results.map((result) => ({
          entityId: result.point.id,
          name: result.point.canonicalName,
          detail: result.point.definition,
          score: result.score,
          retrievalMethod: result.retrievalMethod,
          occurrences: result.occurrences.map((occurrence) => ({
            node: occurrence.nodeTitle,
            pageNumber: occurrence.pageNumber,
            printedPages: occurrence.printedPages,
            sequenceNo: occurrence.sequenceNo,
            recommendedPeriod: occurrence.recommendedPeriod,
            position: currentSequenceNo == null ? undefined : (
              occurrence.sequenceNo < currentSequenceNo ? "before"
                : occurrence.sequenceNo > currentSequenceNo ? "after"
                  : "current"
            ),
          })),
        })),
        sources,
      });
    },
  });

  const readCurriculumKnowledgeContinuity = tool({
    name: "read_curriculum_knowledge_continuity",
    description: "以当前章节和其中一个知识点为基准，检索同册教材中语义相关知识点的前后出现位置。before 是复习候选，after 是铺垫候选；位置与相似度只用于召回，最终是否复习或铺垫必须结合本课目标和学情判断。",
    parameters: z.object({
      textbookId: z.string().trim().min(1).max(80),
      currentNodeId: z.string().trim().min(1).max(80),
      entityId: z.string().uuid(),
      limit: z.number().int().min(1).max(20).nullable().optional(),
    }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const record = await repository.readCurriculumKnowledgeContinuity({
        textbookId: input.textbookId,
        currentNodeId: input.currentNodeId,
        entityId: input.entityId,
        limit: input.limit ?? undefined,
      });
      const sources = uniqueSources([
        ...(record.target?.sources ?? []),
        ...record.candidates.flatMap((candidate) => candidate.point.sources),
      ]);
      if (sources.length) {
        await repository.recordRunEvidence(
          context.userId,
          context.runId,
          "curriculum_knowledge",
          sources,
        );
      }
      return JSON.stringify({
        ...record,
        target: record.target ? {
          entityId: record.target.id,
          name: record.target.canonicalName,
          detail: record.target.definition,
        } : undefined,
        candidates: record.candidates.map((candidate) => ({
          entityId: candidate.point.id,
          name: candidate.point.canonicalName,
          detail: candidate.point.definition,
          score: candidate.score,
          retrievalMethod: candidate.retrievalMethod,
          occurrences: candidate.occurrences.map((occurrence) => ({
            node: occurrence.nodeTitle,
            pageNumber: occurrence.pageNumber,
            printedPages: occurrence.printedPages,
            sequenceNo: occurrence.sequenceNo,
            position: occurrence.position,
          })),
        })),
        inferenceBoundary: "这些是基于相似度与教材顺序召回的候选，不是已确认的先修关系。",
        sources,
      });
    },
  });

  return [
    lookupCurriculumTextbooks,
    searchCurriculumNodes,
    readCurriculumOutline,
    readCurriculumNodeSemantics,
    traceCurriculumLearningPath,
    readCurriculumKnowledgePoints,
    searchCurriculumKnowledgePoints,
    readCurriculumKnowledgeContinuity,
  ];
}
