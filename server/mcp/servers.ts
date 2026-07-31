import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { LessonRepository } from "../repository.js";
import type { McpScope } from "../security/mcp-token.js";
import type { WebSearchProvider } from "../providers/web-search.js";
import { BgeM3EmbeddingProvider } from "../providers/embeddings.js";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

function createKnowledgeServer(repository: LessonRepository, scope: McpScope) {
  const server = new McpServer({ name: "lessonup-knowledge", version: "1.0.0" });
  const embeddings = new BgeM3EmbeddingProvider();
  server.registerTool("search_knowledge", {
    title: "检索备课资料",
    description: "在当前运行允许的公共或私有资料范围内进行混合检索",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(8).default(6) },
  }, async ({ query, limit }) => {
    const vector = await embeddings.embed([query]).then((items) => items[0]).catch(() => undefined);
    return text(await repository.searchKnowledge(
      scope.userId, scope.allowedKnowledgeScopes, query, limit, vector,
    ));
  });
  server.registerTool("get_passage", {
    title: "读取资料片段",
    description: "读取一个已命中的资料片段及有限相邻内容",
    inputSchema: { chunkId: z.string().min(1) },
  }, async ({ chunkId }) => text(await repository.getKnowledgePassage(
    scope.userId, scope.allowedKnowledgeScopes, chunkId,
  )));
  server.registerTool("read_attached_source", {
    title: "读取本轮附带资料",
    description: "按本轮消息提供的来源 ID 直接读取该资料的正文片段；用于优先处理教师刚刚附带的文件",
    inputSchema: {
      sourceId: z.string().uuid(),
      limit: z.number().int().min(1).max(12).default(8),
    },
  }, async ({ sourceId, limit }) => text(await repository.getKnowledgeSourcePassages(
    scope.userId, scope.allowedKnowledgeScopes, sourceId, limit,
  )));
  server.registerTool("get_source", {
    title: "读取来源信息",
    description: "读取当前项目中某个来源的元数据与引用信息",
    inputSchema: { sourceId: z.string().min(1) },
  }, async ({ sourceId }) => {
    const sources = await repository.listProjectSources(scope.userId, scope.allowedKnowledgeScopes);
    return text(sources.find((source) => source.id === sourceId) ?? null);
  });
  server.registerTool("list_project_sources", {
    title: "列出项目资料",
    description: "列出当前备课项目可访问的资料，不返回其他项目内容",
    inputSchema: {},
  }, async () => text(await repository.listProjectSources(scope.userId, scope.allowedKnowledgeScopes)));
  return server;
}

function createWebServer(provider: WebSearchProvider) {
  const server = new McpServer({ name: "lessonup-web", version: "1.0.0" });
  server.registerTool("search_web", {
    title: "联网搜索",
    description: "搜索公开网页；回答中必须保留来源",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(8).default(5) },
  }, async ({ query, limit }) => text(await provider.search(query, limit)));
  server.registerTool("open_web_result", {
    title: "打开网页结果",
    description: "读取搜索结果正文；拒绝内网和文件协议地址",
    inputSchema: { url: z.url() },
  }, async ({ url }) => text(await provider.open(url)));
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
    : createWebServer(args.webProvider);
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(args.request);
}
