import { describe, expect, it } from "vitest";
import { chunkPlainText, parseKnowledgeBytes } from "./worker.js";

describe("knowledge chunking", () => {
  it("keeps short source text in one normalized chunk", () => {
    expect(chunkPlainText("第一段。\r\n\r\n第二段。"))
      .toEqual([{ passage: "第一段。\n\n第二段。" }]);
  });

  it("splits long source text without dropping its final content", () => {
    const text = Array.from({ length: 80 }, (_, index) => `第${index + 1}段课程资料。`).join("\n\n");
    const chunks = chunkPlainText(text, 120, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.passage).toContain("第1段课程资料");
    expect(chunks.at(-1)?.passage).toContain("第80段课程资料");
    expect(chunks.every((chunk) => chunk.passage.length > 0)).toBe(true);
  });

  it("preserves Markdown prose between a heading and a list", async () => {
    const markdown = [
      "# LessonUp 首轮附件验收",
      "",
      "验收代号：LUP-FIRST-TURN-0730。",
      "",
      "1. 第一条观察",
      "2. 第二条观察",
    ].join("\n");

    const parsed = await parseKnowledgeBytes(
      "text/markdown",
      new TextEncoder().encode(markdown).buffer,
    );

    expect(parsed.chunks.map((chunk) => chunk.passage).join("\n"))
      .toContain("验收代号：LUP-FIRST-TURN-0730。");
  });
});
