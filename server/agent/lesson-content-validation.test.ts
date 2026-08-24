import { describe, expect, it } from "vitest";

import { findKnownLessonContentIssues } from "./lesson-content-validation.js";

describe("known lesson content regressions", () => {
  it("rejects the observed incorrect metaphor classifications", () => {
    const issues = findKnownLessonContentIssues([
      "借喻：春天像刚落地的娃娃（本体不出现）。",
      "借喻：像牛毛，像花针，像细丝。",
    ].join("\n"));

    expect(issues.map((issue) => issue.code)).toEqual([
      "spring_baby_metaphor_misclassified",
      "spring_rain_metaphor_misclassified",
    ]);
  });

  it("does not block a correct comparison or an unrelated explanation", () => {
    expect(findKnownLessonContentIssues([
      "明喻：春天像刚落地的娃娃，本体、比喻词、喻体均出现。",
      "借喻应另外选择具有直接文本依据的例句。",
      "朗读“像牛毛，像花针，像细丝”，体会春雨细密轻柔的特点。",
    ].join("\n"))).toEqual([]);
  });
});
