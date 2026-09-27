import { describe, expect, it } from "vitest";
import { classFeedbackProvenance } from "./class-feedback-provenance.js";

describe("class feedback provenance", () => {
  it("keeps teacher facts, inferences and decisions distinct", () => {
    expect(classFeedbackProvenance("observation")).toMatchObject({
      level: "teacher_observation",
      label: "教师课堂事实",
    });
    expect(classFeedbackProvenance("error_cause")).toMatchObject({
      level: "teacher_inference",
      label: "教师推断（待后续观察校正）",
    });
    expect(classFeedbackProvenance("continuity_outcome").boundary)
      .toContain("不是平台已核验的先修关系");
  });
});
