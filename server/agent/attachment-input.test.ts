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

  it("turns a terse confirmation into execution context with version-aware minimal verification", () => {
    const input = buildLessonAgentInput(
      "确认",
      { activeSectionId: "assessment", documentVersion: 4 },
      [],
    );

    expect(input).toContain("接受上一轮的具体修改方案");
    expect(input).toContain("资源版本与已有读取结果一致时直接复用");
    expect(input).toContain("不要再次复述方案或再次询问确认");
  });

  it("marks continue as a request to inherit completed analysis and tools", () => {
    const input = buildLessonAgentInput(
      "继续",
      { activeSectionId: "process", documentVersion: 4 },
      [],
    );

    expect(input).toContain("继承会话中已经形成的目标、分析、完整工具结果");
    expect(input).toContain("不要无条件从头重做");
  });
});
