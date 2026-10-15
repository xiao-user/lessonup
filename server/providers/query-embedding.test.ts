import { describe, expect, it, vi } from "vitest";
import { createQueryEmbedder, tryEmbedQuery } from "./query-embedding.js";

const provider = (embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>) => ({ embed }) as never;

describe("createQueryEmbedder", () => {
  it("is absent when no embedding service is configured", () => {
    expect(createQueryEmbedder(provider(async () => [[1]]), false)).toBeUndefined();
  });

  it("embeds one query and forwards the caller's cancellation", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const embed = createQueryEmbedder(provider(async (texts, signal) => { seen.push(signal); return texts.map(() => [0.1, 0.2]); }), true)!;
    const caller = new AbortController();
    await expect(embed("负数", caller.signal)).resolves.toEqual([0.1, 0.2]);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.aborted).toBe(false);
    caller.abort();
    expect(seen[0]!.aborted).toBe(true);
  });

  it("rejects a response with no vector", async () => {
    const embed = createQueryEmbedder(provider(async () => []), true)!;
    await expect(embed("负数")).rejects.toThrow("embedding_shape_invalid");
  });
});

describe("tryEmbedQuery", () => {
  it("skips embedding when there is no embedder", async () => {
    await expect(tryEmbedQuery(undefined, "负数")).resolves.toEqual({ vector: undefined, degraded: false });
  });

  it("returns the vector on success", async () => {
    await expect(tryEmbedQuery(async () => [1, 2], "负数")).resolves.toEqual({ vector: [1, 2], degraded: false });
  });

  it("degrades to lexical retrieval, and says so, when the service fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(tryEmbedQuery(async () => { throw new Error("embedding_failed:503"); }, "负数"))
        .resolves.toEqual({ vector: undefined, degraded: true });
      expect(warn).toHaveBeenCalledWith("Query embedding unavailable; using lexical retrieval", "embedding_failed:503");
    } finally {
      warn.mockRestore();
    }
  });
});
