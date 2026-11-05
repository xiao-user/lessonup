import { describe, expect, it } from "vitest";
import { deriveReadingEmphasis } from "./reading-emphasis.js";

describe("verified reading-emphasis delivery", () => {
  it("derives the receipt from rendered marks instead of a model-declared manifest", () => {
    expect(deriveReadingEmphasis([{ field: "process", replacement: "圈画具体证据，再解释其作用。" }]))
      .toEqual({ kind: "not_needed", count: 0, fields: [] });
  });

  it("records the actual field and occurrence count rather than merely counting delimiters", () => {
    const operations = [{ field: "process" as const, replacement: "圈画=={pink}具体证据==，再解释其作用。" }];
    expect(deriveReadingEmphasis(operations)).toEqual({ kind: "marked", count: 1, fields: ["process"] });
  });

  it("does not mistake literal code or escaped delimiters for a rendered mark", () => {
    for (const replacement of ["`=={pink}具体证据==`", "\\=={pink}具体证据==", "```\n=={pink}具体证据==\n```"]) {
      expect(deriveReadingEmphasis([{ field: "process", replacement }]))
        .toEqual({ kind: "not_needed", count: 0, fields: [] });
    }
    expect(deriveReadingEmphasis([{ field: "process", replacement: "=={purple}具体证据==" }]))
      .toEqual({ kind: "marked", count: 1, fields: ["process"] });
  });

  it("allows an unmarked local revision without a color quota", () => {
    expect(deriveReadingEmphasis([{ field: "period", replacement: "第2课时" }]))
      .toEqual({ kind: "not_needed", count: 0, fields: [] });
  });

  it("accounts for repeated occurrences and marks preserved in the edited field", () => {
    const operation = { field: "process" as const, replacement: "圈画=={pink}具体证据==，再核对=={pink}具体证据==。" };
    expect(deriveReadingEmphasis([operation])).toEqual({ kind: "marked", count: 2, fields: ["process"] });
  });
});
