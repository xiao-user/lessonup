import { describe, expect, it } from "vitest";
import { MemoryObjectStorage } from "./object-storage.js";

describe("MemoryObjectStorage", () => {
  it("isolates stored bytes and lists by prefix", async () => {
    const storage = new MemoryObjectStorage();
    const original = new Uint8Array([1, 2, 3]);
    await storage.put("private/one.bin", original, { contentType: "application/octet-stream" });
    original[0] = 9;
    await storage.put("private/nested/two.txt", new Blob(["two"]), { contentType: "text/plain" });

    await expect(storage.get("private/one.bin")).resolves.toMatchObject({
      key: "private/one.bin", body: new Uint8Array([1, 2, 3]),
    });
    await expect(storage.list("private/")).resolves.toHaveLength(2);

    await storage.remove(["private/one.bin"]);
    await expect(storage.get("private/one.bin")).resolves.toBeNull();
  });
});
