import { describe, expect, it, vi } from "vitest";

import { createMessageCheckpoint } from "./message-checkpoint.js";

describe("createMessageCheckpoint", () => {
  it("coalesces a burst of streamed text and flushes the final snapshot", async () => {
    vi.useFakeTimers();
    try {
      const persisted: string[] = [];
      const checkpoint = createMessageCheckpoint({
        persist: async (content) => { persisted.push(content); },
        delayMs: 300,
      });

      checkpoint.update("第");
      checkpoint.update("第一");
      checkpoint.update("第一句");
      await vi.advanceTimersByTimeAsync(300);
      expect(persisted).toEqual(["第一句"]);

      checkpoint.update("第一句。第二句");
      await checkpoint.flush("第一句。第二句。");
      expect(persisted).toEqual(["第一句", "第一句。第二句。"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not queue every update while a checkpoint write is in flight", async () => {
    vi.useFakeTimers();
    try {
      const persisted: string[] = [];
      let releaseFirstWrite: (() => void) | undefined;
      let writes = 0;
      const checkpoint = createMessageCheckpoint({
        persist: (content) => {
          persisted.push(content);
          writes += 1;
          return writes === 1
            ? new Promise<void>((resolve) => { releaseFirstWrite = resolve; })
            : Promise.resolve();
        },
        delayMs: 300,
      });

      checkpoint.update("a");
      await vi.advanceTimersByTimeAsync(300);
      checkpoint.update("ab");
      checkpoint.update("abc");
      const flush = checkpoint.flush("abc");
      releaseFirstWrite?.();
      await flush;
      expect(persisted).toEqual(["a", "abc"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
