import { describe, expect, it } from "vitest";

import { presentPatchOperation } from "./document-patch";

describe("patch presentation", () => {
  it("shows the changed context instead of raw offsets for a long replacement", () => {
    const common = "相同的教学过程。".repeat(40);
    const preview = presentPatchOperation({
      field: "process",
      expectedText: `${common}旧问题${common}`,
      replacement: `${common}新问题${common}`,
    });

    expect(preview.fieldLabel).toBe("教学过程");
    expect(preview.isTruncated).toBe(true);
    expect(preview.before).toContain("旧问题");
    expect(preview.after).toContain("新问题");
    expect(preview.before.length).toBeLessThan(preview.fullBefore.length);
  });

  it("identifies historical no-op approvals without presenting them as deletion", () => {
    expect(presentPatchOperation({
      field: "process",
      expectedText: "",
      replacement: "",
    })).toMatchObject({
      isNoEffect: true,
      before: "",
      after: "",
    });
  });
});
