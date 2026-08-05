import { describe, expect, it } from "vitest";

import { dedupeAgentSources, latestAssistantSources } from "./source-state";

describe("assistant source presentation", () => {
  it("collapses repeated chunk references to the same canonical private source", () => {
    expect(dedupeAgentSources([
      { id: "source-1", title: "教学设计.md", kind: "private", chunkId: "chunk-1" },
      { id: "source-1", title: "教学设计.md", kind: "private", chunkId: "chunk-2" },
    ])).toEqual([
      { id: "source-1", title: "教学设计.md", kind: "private", chunkId: "chunk-1" },
    ]);
  });

  it("restores only the latest assistant turn sources instead of the whole branch", () => {
    expect(latestAssistantSources([
      { role: "assistant", sources: [{ id: "old", title: "旧资料.pdf", kind: "private" }] },
      { role: "user", sources: [] },
      { role: "assistant", sources: [{ id: "new", title: "新资料.pdf", kind: "private" }] },
    ])).toEqual([{ id: "new", title: "新资料.pdf", kind: "private" }]);
  });

  it("does not carry an earlier turn source into a later source-free reply", () => {
    expect(latestAssistantSources([
      { role: "assistant", sources: [{ id: "old", title: "旧资料.pdf", kind: "private" }] },
      { role: "user", sources: [] },
      { role: "assistant", sources: [] },
    ])).toEqual([]);
  });

  it("keeps curriculum provenance but removes inaccessible object links", () => {
    expect(dedupeAgentSources([{
      id: "curriculum-1",
      title: "语文七年级上册：济南的冬天",
      url: "https://r1-ndr.ykt.cbern.com.cn/assets/textbook.pdf",
      kind: "public",
    }])).toEqual([{
      id: "curriculum-1",
      title: "语文七年级上册：济南的冬天",
      kind: "public",
    }]);
  });
});
