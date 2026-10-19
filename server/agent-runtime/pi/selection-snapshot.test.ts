import { describe, expect, it } from "vitest";
import type { LessonPlan } from "../../domain.js";
import { prepareCurrentSelection } from "./selection-snapshot.js";
const quote = (fieldSnapshot = "第2课时", patch = {}) => ({ field: "period" as const, start: 0, end: 4, text: "第2课时", fieldSnapshot, baseDocumentVersion: 1, documentVersion: 2, ...patch });
const doc = (period = "第2课时") => ({ period } as LessonPlan);
describe("canonical selection preparation", () => {
  it("strips the field snapshot while retaining verified quote provenance", () => {
    expect(prepareCurrentSelection(quote(), doc(), 2)).toEqual({ field: "period", start: 0, end: 4, text: "第2课时", documentVersion: 2 });
  });
  it("rejects stale fields, versions, and forged quote text", () => {
    for (const selection of [quote("第1课时"), quote(undefined, { documentVersion: 1 }), quote(undefined, { text: "第1课时" }), quote(undefined, { baseDocumentVersion: undefined })]) {
      expect(() => prepareCurrentSelection(selection, doc(), 2)).toThrow("selection_context_stale");
    }
  });
  it("verifies the editor's once-decoded entity text without decoding the selection twice", () => {
    const field = "讨论 &amp;lt;原句&amp;gt; 的作用";
    const text = "&lt;原句&gt;";
    expect(prepareCurrentSelection(quote(field, { text }), doc(field), 2)?.text).toBe(text);
  });
  it.each(["`==代码示例==`", "\\==代码示例=="])("preserves visible marker syntax in code or escaped text: %s", field => {
    const text = "==代码示例==";
    expect(prepareCurrentSelection(quote(field, { text }), doc(field), 2)?.text).toBe(text);
  });
  it("validates visible Markdown across formatting rather than slicing editor offsets", () => {
    const field = "**独立**解释[表达效果](https://example.test)";
    expect(prepareCurrentSelection(quote(field, { text: "独立解释表达效果" }), doc(field), 2)?.text).toBe("独立解释表达效果");
    expect(() => prepareCurrentSelection(quote(field, { text: "https://example.test" }), doc(field), 2)).toThrow();
  });
});
