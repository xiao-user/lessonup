import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { createMcpScopeToken } from "../security/mcp-token.js";

describe("MCP Streamable HTTP integration", () => {
  it("authenticates, negotiates the protocol, and calls a real knowledge tool", async () => {
    const repository = new MemoryLessonRepository();
    const app = createApp(repository, { agent: null, threadStarterGenerator: null });
    const token = await createMcpScopeToken({
      userId: "00000000-0000-4000-8000-00000000000a",
      runId: crypto.randomUUID(),
      notebookId: "notebook-1",
      lessonFileId: "file-1",
      allowedKnowledgeScopes: [
        "user:00000000-0000-4000-8000-00000000000a",
        "notebook:notebook-1",
        "file:file-1",
      ],
      attachmentSourceIds: [],
    });
    const client = new Client({ name: "lessonup-integration-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://lessonup.test/mcp/knowledge"),
      {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (input, init) => app.fetch(new Request(input, init)),
      },
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("list_project_sources");
      const result = await client.callTool({ name: "list_project_sources", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "[]" }]);
    } finally {
      await client.close();
    }
  });
});
