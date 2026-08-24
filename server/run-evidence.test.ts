import { describe, expect, it } from "vitest";

import type { SourceRef } from "./domain.js";
import { runEvidenceIdentity, uniqueRunEvidenceSources } from "./run-evidence.js";

const source = (chunkId: string, page: number): SourceRef => ({
  id: "curriculum-standard-source",
  title: "义务教育语文课程标准（2022年版）",
  kind: "public",
  chunkId,
  page,
});

describe("run evidence identity", () => {
  it("preserves distinct observed chunks from the same source", () => {
    const first = source("standard:page-21", 21);
    const second = source("standard:page-33", 33);

    expect(runEvidenceIdentity(first)).not.toBe(runEvidenceIdentity(second));
    expect(uniqueRunEvidenceSources([first, second])).toEqual([first, second]);
  });

  it("deduplicates an exact chunk replay before a batch upsert", () => {
    const first = source("standard:page-21", 21);
    const replay = { ...first };

    expect(uniqueRunEvidenceSources([first, replay])).toEqual([replay]);
  });
});
