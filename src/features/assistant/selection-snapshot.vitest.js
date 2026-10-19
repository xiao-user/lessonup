import { describe, expect, it } from "vitest";
import { prepareSelectionSnapshot } from "./selection-snapshot.js";
describe("prepareSelectionSnapshot", () => {
  const selection = { field: "period", start: 0, end: 5, text: "第1课时", fieldSnapshot: "第1课时", baseDocumentVersion: 1 };
  it("binds a still matching field to the flushed version", () => {
    expect(prepareSelectionSnapshot(selection, { period: "第1课时" }, 2)).toMatchObject({ documentVersion: 2 });
  });
  it("rejects the actual stale selected period rather than mixing it with the saved second period", () => {
    expect(() => prepareSelectionSnapshot(selection, { period: "第2课时" }, 2)).toThrow("selection_context_stale");
  });
  it("rejects absent quote text even when the raw field snapshot matches", () => {
    expect(() => prepareSelectionSnapshot({ ...selection, text: "不在规范原文中" }, { period: "第1课时" }, 2)).toThrow("selection_context_stale");
    expect(() => prepareSelectionSnapshot({ ...selection, text: " " }, { period: "第1课时" }, 2)).toThrow("selection_context_stale");
  });
  it("keeps visible once-decoded entities and marker text without rewriting the selected quote", () => {
    const fieldSnapshot = "=={pink}讨论 **&amp;lt;原句&amp;gt;**==";
    const text = "讨论 &lt;原句&gt;";
    const prepared = prepareSelectionSnapshot({ ...selection, fieldSnapshot, text }, { period: fieldSnapshot }, 2);
    expect(prepared).toMatchObject({ text, fieldSnapshot, documentVersion: 2 });
  });
  it("requires selection provenance and rejects a future source version", () => {
    expect(() => prepareSelectionSnapshot({ ...selection, baseDocumentVersion: 3 }, { period: "第1课时" }, 2)).toThrow();
    expect(() => prepareSelectionSnapshot({ field: "period", text: "第1课时" }, { period: "第1课时" }, 2)).toThrow();
    expect(prepareSelectionSnapshot(null, undefined, 2)).toBeUndefined();
  });
});
