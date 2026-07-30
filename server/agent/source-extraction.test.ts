import { describe, expect, it } from "vitest";
import { extractSources } from "./source-extraction.js";

describe("extractSources", () => {
  it("reads the text content block returned by an Agents SDK MCP tool", () => {
    const output = {
      type: "text",
      text: JSON.stringify([{
        title: "Tavily API Reference",
        url: "https://docs.tavily.com/api",
        content: "Search API",
      }]),
    };

    expect(extractSources(output)).toEqual([{
      id: "https://docs.tavily.com/api",
      title: "Tavily API Reference",
      url: "https://docs.tavily.com/api",
      kind: "web",
      page: undefined,
      chunkId: undefined,
    }]);
  });

  it("preserves explicit knowledge kinds and stable chunk references", () => {
    const output = JSON.stringify([{
      id: "source-1",
      title: "课程标准",
      url: "https://example.com/curriculum.pdf",
      kind: "public",
      page: 12,
      chunkId: "chunk-1",
      passage: "课程目标",
    }]);

    expect(extractSources(output)).toEqual([{
      id: "source-1",
      title: "课程标准",
      url: "https://example.com/curriculum.pdf",
      kind: "public",
      page: 12,
      chunkId: "chunk-1",
    }]);
  });

  it("ignores prose and open-page payloads without a source title", () => {
    expect(extractSources({
      type: "text",
      text: JSON.stringify({ url: "https://example.com", content: "Page body" }),
    })).toEqual([]);
    expect(extractSources("not json")).toEqual([]);
  });
});
