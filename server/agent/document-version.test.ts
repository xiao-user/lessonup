import { describe, expect, it } from "vitest";
import { assertCurrentDocumentVersion } from "./document-version.js";

describe("assertCurrentDocumentVersion", () => {
  it("accepts the exact visible document version", () => {
    expect(() => assertCurrentDocumentVersion(7, 7)).not.toThrow();
  });

  it("rejects a run started from stale visible content", () => {
    expect(() => assertCurrentDocumentVersion(8, 7)).toThrowError("document_context_stale");
  });

  it("allows approval recovery when no client version is supplied", () => {
    expect(() => assertCurrentDocumentVersion(8)).not.toThrow();
  });
});
