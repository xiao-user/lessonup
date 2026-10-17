import { describe, expect, it } from "vitest";
import { reconcilePresentationMaterial } from "./presentation-material-state.js";

describe("A4 presentation polling", () => {
  it("does not remeasure the lesson or dismiss a delete confirmation for unchanged data", () => {
    const current = { presentation: { id: "p", updatedAt: "v1", checksum: "a" }, state: "idle", error: "", confirmingDelete: true };
    expect(reconcilePresentationMaterial(current, { ...current.presentation }, null, "")).toBe(current);
    expect(reconcilePresentationMaterial(current, { ...current.presentation, updatedAt: "v2", checksum: "b" }, null, ""))
      .toMatchObject({ confirmingDelete: false, presentation: { checksum: "b" } });
  });
  it("keeps deletion owned by its request and detects real generation changes", () => {
    const current = { presentation: null, state: "deleting", error: "", confirmingDelete: true };
    expect(reconcilePresentationMaterial(current, null, { status: "generating" }, "")).toBe(current);
    expect(reconcilePresentationMaterial({ ...current, state: "idle" }, null, { status: "generating" }, "").state).toBe("generating");
  });
});
