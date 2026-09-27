import { describe, expect, it } from "vitest";
import { firstChangedRuntimeMessageIndex, runtimeSessionWritePlan } from "./runtime-session-persist.js";

describe("runtimeSessionWritePlan", () => {
  it("appends only the new tail", () => {
    expect(runtimeSessionWritePlan(2, 3)).toEqual({ deleteAfter: null, appendFrom: 2 });
  });

  it("truncates a repaired shorter prefix without rewriting earlier rows", () => {
    expect(runtimeSessionWritePlan(4, 2)).toEqual({ deleteAfter: 2, appendFrom: 2 });
  });

  it("writes the full prefix into an empty row store", () => {
    expect(runtimeSessionWritePlan(0, 3)).toEqual({ deleteAfter: null, appendFrom: 0 });
  });

  it("leaves messages unchanged when the prefix length matches", () => {
    expect(runtimeSessionWritePlan(3, 3)).toEqual({ deleteAfter: null, appendFrom: 3 });
  });

  it("rewrites from the first changed index without touching the kept prefix", () => {
    expect(runtimeSessionWritePlan(4, 4, 2)).toEqual({ deleteAfter: 2, appendFrom: 2 });
  });

  it("treats a first-changed index at the stored end as a tail append", () => {
    expect(runtimeSessionWritePlan(2, 3, 2)).toEqual({ deleteAfter: null, appendFrom: 2 });
  });
});

describe("firstChangedRuntimeMessageIndex", () => {
  it("returns the first index whose encoded payload differs", () => {
    expect(firstChangedRuntimeMessageIndex(
      [{ role: "user" }, { role: "assistant" }, { status: "approval_required" }],
      [{ role: "user" }, { role: "assistant" }, { error: "approval_not_persisted" }],
    )).toBe(2);
  });

  it("returns the shared length when the incoming prefix only grows", () => {
    expect(firstChangedRuntimeMessageIndex(
      [{ role: "user" }],
      [{ role: "user" }, { role: "assistant" }],
    )).toBe(1);
  });
});
