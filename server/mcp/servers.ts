import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { LessonRepository } from "../repository.js";
import type { McpScope } from "../security/mcp-token.js";
import type { WebSearchProvider } from "../providers/web-search.js";
import { ConfiguredEmbeddingProvider } from "../providers/embeddings.js";
import type { SourceRef } from "../domain.js";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// Bump whenever retrieval filtering or ranking semantics change so results
// produced by an older SQL contract cannot silently bypass the new policy.
export const CURRICULUM_STANDARD_RETRIEVAL_VERSION = "grade-aware-v2";

export const normalizedCurriculumStandardQuery = (query: string) => query
  .normalize("NFKC")
  .trim()
  .replace(/\s+/g, " ");

export const curriculumStandardSearchCacheIdentity = (input: {
  releaseFingerprint: string | null;
  subject: string;
  stage: string;
  grade: string;
  query: string;
}) => ({
  contextFingerprint: sha256(JSON.stringify({
    retrievalVersion: CURRICULUM_STANDARD_RETRIEVAL_VERSION,
    release: input.releaseFingerprint ?? "unpublished",
    subject: input.subject,
    stage: input.stage,
    grade: input.grade,
  })),
  querySha256: sha256(normalizedCurriculumStandardQuery(input.query)),
});

export async function searchScopedCurriculumStandards(args: {
  repository: LessonRepository;
  scope: McpScope;
  query: string;
  limit: number;
  embed: (query: string) => Promise<number[] | undefined>;
}) {
  const notebook = await args.repository.getNotebook(args.scope.userId, args.scope.notebookId);
  if (!notebook) throw new Error("notebook_not_found");
  const releaseFingerprint = await args.repository.getPublishedCurriculumStandardFingerprint();
  const cacheIdentity = curriculumStandardSearchCacheIdentity({
    releaseFingerprint,
    subject: notebook.subject,
    stage: notebook.stage,
    grade: notebook.grade,
    query: args.query,
  });
  const cached = await args.repository.getCurriculumStandardSearchCache({
    ...cacheIdentity,
    limit: args.limit,
  }).catch(() => null);
  let results: Awaited<ReturnType<LessonRepository["searchCurriculumStandards"]>>;
  let freshness: "reused" | "retrieved";
  if (cached) {
    results = cached.results;
    freshness = "reused";
  } else {
    const normalizedQuery = normalizedCurriculumStandardQuery(args.query);
    const vector = await args.embed(normalizedQuery);
    results = await args.repository.searchCurriculumStandards({
      query: normalizedQuery,
      subject: notebook.subject,
      stage: notebook.stage,
      grade: notebook.grade,
      limit: args.limit,
      embedding: vector,
    });
    freshness = "retrieved";
    await args.repository.saveCurriculumStandardSearchCache({
      ...cacheIdentity,
      limit: args.limit,
      results,
    }).catch(() => undefined);
  }
  await args.repository.recordRunEvidence(
    args.scope.userId,
    args.scope.runId,
    "curriculum_standard_search",
    results,
  );
  return { status: results.length ? "available" as const : "unavailable" as const, freshness, results };
}

function createKnowledgeServer(repository: LessonRepository, scope: McpScope) {
  const server = new McpServer({ name: "lessonup-knowledge", version: "1.0.0" });
  const embeddings = new ConfiguredEmbeddingProvider();
  server.registerTool("search_knowledge", {
    title: "检索备课资料",
    description: "在当前运行允许的公共或私有资料范围内进行混合检索",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(8).default(6) },
  }, async ({ query, limit }) => {
    const vector = await embeddings.embed([query]).then((items) => items[0]).catch(() => undefined);
    const results = await repository.searchKnowledge(
      scope.userId, scope.allowedKnowledgeScopes, query, limit, vector,
    );
    await repository.recordRunEvidence(scope.userId, scope.runId, "knowledge_search", results);
    return text(results);
  });
  server.registerTool("search_curriculum_standards", {
    title: "检索当前学科课标",
    description: "按当前备课项目已经验证的学科、学段和年级范围检索已发布的国家课程标准和共用课程方案；无需也不允许模型自行指定学科范围。返回 freshness=reused 表示同一发布版本、范围和查询的最新结果已直接复用，无需重复检索。",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(8).default(6) },
  }, async ({ query, limit }) => {
    return text(await searchScopedCurriculumStandards({
      repository,
      scope,
      query,
      limit,
      embed: (normalizedQuery) => embeddings.embed([normalizedQuery])
        .then((items) => items[0])
        .catch(() => undefined),
    }));
  });
  server.registerTool("get_passage", {
    title: "读取资料片段",
    description: "读取一个已命中的资料片段及有限相邻内容",
    inputSchema: { chunkId: z.string().min(1) },
  }, async ({ chunkId }) => {
    const result = await repository.getKnowledgePassage(
      scope.userId, scope.allowedKnowledgeScopes, chunkId,
    );
    if (result) {
      await repository.recordRunEvidence(scope.userId, scope.runId, "knowledge_passage", [result]);
    }
    return text(result);
  });
  server.registerTool("read_attached_source", {
    title: "读取本轮附带资料",
    description: "按本轮消息提供的来源 ID 直接读取该资料的正文片段；用于优先处理教师刚刚附带的文件",
    inputSchema: {
      sourceId: z.string().uuid(),
      limit: z.number().int().min(1).max(12).default(8),
    },
  }, async ({ sourceId, limit }) => {
    if (!scope.attachmentSourceIds.includes(sourceId)) {
      throw new Error("attachment_not_bound_to_run");
    }
    const results = await repository.getKnowledgeSourcePassages(
      scope.userId, scope.allowedKnowledgeScopes, sourceId, limit,
    );
    await repository.recordRunEvidence(scope.userId, scope.runId, "attachment_read", results);
    return text(results);
  });
  server.registerTool("get_source", {
    title: "读取来源信息",
    description: "读取当前项目中某个来源的元数据与引用信息",
    inputSchema: { sourceId: z.string().min(1) },
  }, async ({ sourceId }) => {
    const sources = await repository.listProjectSources(scope.userId, scope.allowedKnowledgeScopes);
    const source = sources.find((item) => item.id === sourceId) ?? null;
    if (source) {
      await repository.recordRunEvidence(scope.userId, scope.runId, "source_metadata", [source]);
    }
    return text(source);
  });
  server.registerTool("list_project_sources", {
    title: "列出项目资料",
    description: "列出当前备课项目可访问的资料，不返回其他项目内容",
    inputSchema: {},
  }, async () => text(await repository.listProjectSources(scope.userId, scope.allowedKnowledgeScopes)));
  return server;
}

function createWebServer(repository: LessonRepository, scope: McpScope, provider: WebSearchProvider) {
  const server = new McpServer({ name: "lessonup-web", version: "1.0.0" });
  server.registerTool("search_web", {
    title: "联网搜索",
    description: "搜索公开网页；回答中必须保留来源",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(8).default(5) },
  }, async ({ query, limit }) => {
    const results = await provider.search(query, limit);
    const sources: SourceRef[] = results.map((result) => ({
      id: result.url,
      title: result.title,
      url: result.url,
      kind: "web",
    }));
    await repository.recordRunEvidence(scope.userId, scope.runId, "web_search", sources);
    return text(results);
  });
  server.registerTool("open_web_result", {
    title: "打开网页结果",
    description: "读取搜索结果正文；拒绝内网和文件协议地址",
    inputSchema: { url: z.url() },
  }, async ({ url }) => {
    const opened = await provider.open(url);
    const prior = (await repository.listRunEvidence(scope.userId, scope.runId))
      .find((item) => item.source.url === opened.url);
    const source: SourceRef = prior?.source ?? {
      id: opened.url,
      title: new URL(opened.url).hostname,
      url: opened.url,
      kind: "web",
    };
    await repository.recordRunEvidence(scope.userId, scope.runId, "web_open", [source]);
    return text({ ...opened, title: source.title });
  });
  return server;
}

export async function handleMcpRequest(args: {
  kind: "knowledge" | "web";
  request: Request;
  repository: LessonRepository;
  scope: McpScope;
  webProvider: WebSearchProvider;
}) {
  const server = args.kind === "knowledge"
    ? createKnowledgeServer(args.repository, args.scope)
    : createWebServer(args.repository, args.scope, args.webProvider);
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(args.request);
}
