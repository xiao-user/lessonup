import { describe, expect, it } from "vitest";
import { extractSources } from "./source-extraction.js";

describe("extractSources", () => {
  it("reads the text content block returned by an MCP tool", () => {
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

  it("extracts sources nested in a curriculum-standard result envelope", () => {
    expect(extractSources({
      status: "available",
      freshness: "reused",
      results: [{
        id: "standard-1",
        chunkId: "standard-1",
        title: "义务教育语文课程标准（2022年版）",
        kind: "public",
        page: 12,
        passage: "正文不会作为来源元数据暴露。",
        score: 0.98,
      }],
    })).toEqual([{
      id: "standard-1",
      chunkId: "standard-1",
      title: "义务教育语文课程标准（2022年版）",
      kind: "public",
      page: 12,
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

  it("extracts the standard sources array from a structured function-tool result", () => {
    expect(extractSources(JSON.stringify({
      count: 1,
      matches: [{ node: { title: "1 春", pageNumber: 9 } }],
      sources: [{
        id: "curriculum:book:9",
        title: "语文七年级上册（国家智慧教育平台目录）",
        url: "https://example.com/tree.json",
        kind: "public",
        page: 9,
      }],
    }))).toEqual([{
      id: "curriculum:book:9",
      title: "语文七年级上册（国家智慧教育平台目录）",
      url: "https://example.com/tree.json",
      kind: "public",
      page: 9,
      chunkId: undefined,
    }]);
  });

  it("does not persist an inaccessible curriculum object URL into the conversation", () => {
    expect(extractSources(JSON.stringify({
      sources: [{
        id: "curriculum-knowledge:1",
        title: "语文七年级上册：核心知识",
        url: "https://r1-ndr.ykt.cbern.com.cn/assets/textbook.pdf",
        kind: "public",
      }],
    }))).toEqual([{
      id: "curriculum-knowledge:1",
      title: "语文七年级上册：核心知识",
      kind: "public",
      page: undefined,
      chunkId: undefined,
    }]);
  });
});
