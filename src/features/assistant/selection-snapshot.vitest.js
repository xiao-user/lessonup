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
  it("requires selection provenance and rejects a future source version", () => {
    expect(() => prepareSelectionSnapshot({ ...selection, baseDocumentVersion: 3 }, { period: "第1课时" }, 2)).toThrow();
    expect(() => prepareSelectionSnapshot({ field: "period", text: "第1课时" }, { period: "第1课时" }, 2)).toThrow();
    expect(prepareSelectionSnapshot(null, undefined, 2)).toBeUndefined();
  });
});
