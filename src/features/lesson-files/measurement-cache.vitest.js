import { describe, expect, it } from "vitest";
import { createMeasurementCache } from "./measurement-cache.js";

describe("workspace measurement retention", () => {
  it("reuses exact source only and bounds both retained text and count", () => {
    const cache = createMeasurementCache(2, 8);
    cache.set("one", 12); cache.set("two", 14);
    expect(cache.get("one")).toBe(12);
    expect(cache.get("ONE")).toBeUndefined();
    cache.set("three", 20);
    expect(cache.get("one")).toBeUndefined();
    expect(cache.size).toBe(2);
    cache.set("oversize-source", 50);
    expect(cache.size).toBe(2);
    cache.set("three", 22); expect(cache.get("three")).toBe(22);
    cache.clear(); expect(cache.size).toBe(0);
  });
});
