import { describe, expect, it } from "vitest";
import { bindPatchToObservedEvidence } from "./evidence.js";

const patch = {
  fileId: "file",
  baseDocumentVersion: 1,
  summary: "补充可核验事实",
  operations: [{
    op: "replace_text" as const,
    field: "objectives" as const,
    start: 0,
    end: 0,
    expectedText: "",
    replacement: "王安石是北宋人。",
  }],
};

const evidence = [{
  ownerId: "owner",
  runId: "run",
  kind: "knowledge_passage" as const,
  source: { id: "source-1", title: "人物资料", kind: "public" as const, page: 2 },
  createdAt: new Date().toISOString(),
}];

describe("bindPatchToObservedEvidence", () => {
  it("binds observed evidence when the semantic proposal has no model-authored citations", () => {
    expect(bindPatchToObservedEvidence({
      patch,
      evidence,
      evidenceRequired: true,
    }).citations).toEqual([evidence[0].source]);
  });

  it("rejects model-authored citations that were not observed", () => {
    expect(() => bindPatchToObservedEvidence({
      patch: {
        ...patch,
        citations: [{ id: "invented", title: "虚构资料", kind: "public" }],
      },
      evidence,
      evidenceRequired: true,
    })).toThrow("unverified_patch_citation");
  });

  it("replaces model metadata with the canonical observed source", () => {
    const result = bindPatchToObservedEvidence({
      patch: {
        ...patch,
        citations: [{ id: "source-1", title: "模型自填标题", kind: "private" }],
      },
      evidence,
      evidenceRequired: true,
    });
    expect(result.citations).toEqual([evidence[0].source]);
  });
});
