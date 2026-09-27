import { describe, expect, it } from "vitest";
import { R2ObjectStorage } from "./r2-object-storage.js";

describe("R2ObjectStorage", () => {
  it("chunks deletes behind the portable object-storage port", async () => {
    const deleted: string[][] = [];
    const storage = new R2ObjectStorage({
      put: async () => null,
      get: async () => null,
      list: async () => ({ objects: [], truncated: false }),
      delete: async (keys) => { deleted.push(keys); },
    });

    await storage.remove(Array.from({ length: 1_001 }, (_, index) => `source/${index}`));
    expect(deleted.map((keys) => keys.length)).toEqual([1_000, 1]);
  });
});
