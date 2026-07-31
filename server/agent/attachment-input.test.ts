import { describe, expect, it } from "vitest";

import { buildLessonAgentInput } from "./harness.js";

describe("attachment run input", () => {
  it("provides verified resources without forcing a hard-coded first tool call", () => {
    const input = buildLessonAgentInput(
      "结合附件判断目标是否合理",
      { activeSectionId: "objectives", documentVersion: 3 },
      [{ id: "source-1", title: "课程说明.pdf", kind: "private" }],
    );

    expect(input).toContain("sourceId: source-1");
    expect(input).toContain("根据教师问题决定读取范围");
    expect(input).toContain("必须先调用 read_attached_source 取得直接证据");
    expect(input).not.toContain("必须先逐个调用");
    expect(input).not.toContain("必须先对每个");
  });
});
