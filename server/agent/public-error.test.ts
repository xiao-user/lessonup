import { describe, expect, it } from "vitest";
import { DocumentPatchError } from "../document-patch.js";
import { publicAgentError } from "./public-error.js";

describe("publicAgentError", () => {
  it("does not expose internal document fields for stale patch text", () => {
    expect(publicAgentError(
      new DocumentPatchError("text_mismatch", "process 的原文已经变化"),
    )).toBe("stale_document");
  });

  it("preserves stable non-document error codes", () => {
    expect(publicAgentError(new Error("active_run_exists"))).toBe("active_run_exists");
  });
});
