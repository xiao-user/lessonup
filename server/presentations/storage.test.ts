import { describe, expect, it } from "vitest";
import { MemoryObjectStorage } from "../platform/object-storage.js";
import { PresentationArtifactStorage } from "./storage.js";

describe("PresentationArtifactStorage", () => {
  it("persists only the generated HTML through the provider-neutral storage port", async () => {
    const storage = new MemoryObjectStorage();
    const artifacts = new PresentationArtifactStorage(storage);
    const ownerId = "00000000-0000-4000-8000-000000000001";
    const presentationId = "00000000-0000-4000-8000-000000000010";

    await artifacts.save(ownerId, presentationId, {
      byteSize: 38,
      files: [
        { path: "index.html", body: new TextEncoder().encode("<main>Lesson</main>") },
        { path: "assets/app.js", body: new TextEncoder().encode("export {}") },
      ],
    });

    await expect(storage.list(`${ownerId}/presentations/${presentationId}`)).resolves.toHaveLength(1);
    await expect(artifacts.load(ownerId, presentationId, artifacts.keyFor(ownerId, presentationId))).resolves.toMatchObject({
      files: [{ path: "index.html", body: new TextEncoder().encode("<main>Lesson</main>") }],
    });

    await artifacts.remove(ownerId, presentationId, artifacts.keyFor(ownerId, presentationId));
    await expect(artifacts.load(ownerId, presentationId, artifacts.keyFor(ownerId, presentationId))).rejects.toThrow("presentation_storage_bundle_missing");
  });

  it("does not leave an artifact when the single HTML upload fails", async () => {
    const memory = new MemoryObjectStorage();
    let writes = 0;
    const storage = {
      put: async (...args: Parameters<MemoryObjectStorage["put"]>) => {
        writes += 1;
        if (writes === 1) throw new Error("r2_unavailable");
        await memory.put(...args);
      },
      get: memory.get.bind(memory),
      list: memory.list.bind(memory),
      remove: memory.remove.bind(memory),
    };
    const artifacts = new PresentationArtifactStorage(storage);
    const ownerId = "00000000-0000-4000-8000-000000000001";
    const presentationId = "00000000-0000-4000-8000-000000000011";

    await expect(artifacts.save(ownerId, presentationId, {
      byteSize: 25,
      files: [
        { path: "index.html", body: new TextEncoder().encode("<main />") },
        { path: "goal.json", body: new TextEncoder().encode("{}") },
      ],
    })).rejects.toThrow("r2_unavailable");

    await expect(memory.list("")).resolves.toEqual([]);
  });
});
