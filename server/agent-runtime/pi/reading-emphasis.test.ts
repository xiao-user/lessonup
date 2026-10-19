import { describe, expect, it } from "vitest";
import { verifyReadingEmphasis } from "./reading-emphasis.js";

const marked = (text = "具体证据", tone: "pink" | "blue" = "pink") => ({
  kind: "marked" as const, reason: "证据是解释的依据。",
  spans: [{ field: "process" as const, text, tone }],
});

describe("verified reading-emphasis delivery", () => {
  it("rejects a claimed mark that never reached the actual replacement", () => {
    expect(() => verifyReadingEmphasis(marked(), [{ field: "process", replacement: "圈画具体证据，再解释其作用。" }]))
      .toThrow("reading_emphasis_mismatch");
  });

  it("verifies the actual field, complete text and tone, rather than merely counting delimiters", () => {
    const operations = [{ field: "process" as const, replacement: "圈画=={pink}具体证据==，再解释其作用。" }];
    expect(verifyReadingEmphasis(marked(), operations)).toMatchObject({ kind: "marked", count: 1, fields: ["process"] });
    expect(() => verifyReadingEmphasis(marked("具体证据", "blue"), operations)).toThrow("reading_emphasis_mismatch");
    expect(() => verifyReadingEmphasis({ ...marked(), spans: [{ field: "assessment", text: "具体证据", tone: "pink" }] }, operations)).toThrow("reading_emphasis_mismatch");
  });

  it("does not mistake literal code, escapes or an unrendered annotation for a mark", () => {
    for (const replacement of ["`=={pink}具体证据==`", "\\=={pink}具体证据==", "```\n=={pink}具体证据==\n```", "=={purple}具体证据=="]) {
      expect(() => verifyReadingEmphasis(marked(), [{ field: "process", replacement }])).toThrow("reading_emphasis_mismatch");
    }
  });

  it("allows an explicitly justified unmarked local revision without a color quota", () => {
    expect(verifyReadingEmphasis({ kind: "not_needed", reason: "本次只修正课时数字，已有表格层级足够。" }, [{ field: "period", replacement: "第2课时" }]))
      .toEqual({ kind: "not_needed", count: 0, fields: [], reason: "本次只修正课时数字，已有表格层级足够。" });
  });

  it("accounts for repeated occurrences and marks preserved in the edited field", () => {
    const operation = { field: "process" as const, replacement: "圈画=={pink}具体证据==，再核对=={pink}具体证据==。" };
    expect(() => verifyReadingEmphasis(marked(), [operation])).toThrow("reading_emphasis_mismatch");
    expect(verifyReadingEmphasis({ ...marked(), spans: [...marked().spans, ...marked().spans] }, [operation]).count).toBe(2);
    expect(() => verifyReadingEmphasis({ kind: "not_needed", reason: "本次无笔迹。" }, [operation])).toThrow("reading_emphasis_mismatch");
  });
});
