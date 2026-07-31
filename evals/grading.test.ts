import { describe, expect, it } from "vitest";
import { finalizeBusinessGrade } from "./grading.js";

const rubric = {
  criteria: ["对应教案原文", "避免伪精确结论"],
  minimumScore: 0.75,
  requireDocumentGrounding: true,
  rejectGeneric: true,
  rejectUnsupportedPrecision: true,
};

describe("business eval gate", () => {
  it("fails a generic answer even when every execution contract could pass", () => {
    const result = finalizeBusinessGrade({
      criteria: [
        { index: 0, score: 1, evidence: "只提到目标" },
        { index: 1, score: 2, evidence: "没有时间估计" },
      ],
      generic: true,
      unsupportedPrecision: false,
      documentGrounded: false,
      summary: "内容可替换到多数教案。",
    }, rubric);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "generic_response",
      "document_not_grounded",
    ]));
  });

  it("fails unsupported precision and any zero-scored critical criterion", () => {
    const result = finalizeBusinessGrade({
      criteria: [
        { index: 0, score: 2, evidence: "引用了教学过程" },
        { index: 1, score: 0, evidence: "无条件断言至少需要十分钟" },
      ],
      generic: false,
      unsupportedPrecision: true,
      documentGrounded: true,
      summary: "存在伪精确判断。",
    }, rubric);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "rubric_failed:1",
      "unsupported_precision",
    ]));
  });
});
