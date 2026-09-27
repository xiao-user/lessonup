import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { LessonRepository } from "../../repository.js";
import type { WebSearchProvider } from "../../providers/web-search.js";

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: null,
});
const sourceId = (url: string) => `web:${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;

export function createPiWebTools(args: {
  repository: LessonRepository;
  provider: WebSearchProvider;
  ownerId: string;
  runId: string;
}): AgentTool<any>[] {
  const search: AgentTool<any> = {
    name: "search_web",
    label: "联网搜索",
    description: "搜索公开网页；结果摘要只用于定位，引用或判断前应打开具体结果。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const { query, limit } = input as { query: string; limit?: number };
      const results = await args.provider.search(query, limit);
      const sources = results.map((result) => ({
        id: sourceId(result.url),
        title: result.title,
        url: result.url,
        kind: "web" as const,
      }));
      await args.repository.recordRunEvidence(args.ownerId, args.runId, "web_search", sources);
      return textResult({ results, sources });
    },
  };
  const open: AgentTool<any> = {
    name: "open_web_result",
    label: "读取网页",
    description: "安全打开公开 HTTP(S) 网页正文，拒绝私网、文件 URL 和不安全重定向。",
    parameters: Type.Object({ url: Type.String({ format: "uri", maxLength: 2_000 }) }, {
      additionalProperties: false,
    }),
    execute: async (_toolCallId, input) => {
      const { url } = input as { url: string };
      const result = await args.provider.open(url);
      const source = { id: sourceId(result.url), title: result.url, url: result.url, kind: "web" as const };
      await args.repository.recordRunEvidence(args.ownerId, args.runId, "web_open", [source]);
      return textResult({ ...result, source });
    },
  };
  return [search, open];
}
