import { describe, expect, it } from "vitest";
import {
  hasMeaningfulKnowledgeContent,
  resolveKnowledgeMediaType,
  safeKnowledgeStorageFilename,
} from "./uploads.js";

describe("resolveKnowledgeMediaType", () => {
  it("uses an allowed browser media type", () => {
    expect(resolveKnowledgeMediaType({ name: "source.bin", type: "text/plain" })).toBe("text/plain");
  });

  it("recovers the media type from a supported extension", () => {
    expect(resolveKnowledgeMediaType({ name: "课堂观察.MD", type: "" })).toBe("text/markdown");
    expect(resolveKnowledgeMediaType({ name: "教案.docx", type: "application/octet-stream" }))
      .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("rejects unsupported extensions with unknown media types", () => {
    expect(resolveKnowledgeMediaType({ name: "private.zip", type: "application/octet-stream" })).toBeUndefined();
  });
});

describe("safeKnowledgeStorageFilename", () => {
  it("keeps the extension but never places a Chinese display name in the Storage key", () => {
    expect(safeKnowledgeStorageFilename(
      "这是一份名称非常非常长用于验证状态不被挤压的首轮附件验收资料.md",
    )).toBe("source.md");
  });

  it("preserves a safe ASCII stem", () => {
    expect(safeKnowledgeStorageFilename("lesson-observation.v2.PDF"))
      .toBe("lesson-observation.v2.pdf");
  });
});

describe("hasMeaningfulKnowledgeContent", () => {
  it("rejects empty and whitespace-only text before enqueueing", async () => {
    await expect(hasMeaningfulKnowledgeContent(
      new File([], "empty.md", { type: "text/markdown" }),
      "text/markdown",
    )).resolves.toBe(false);
    await expect(hasMeaningfulKnowledgeContent(
      new File([" \n\t"], "blank.txt", { type: "text/plain" }),
      "text/plain",
    )).resolves.toBe(false);
  });

  it("accepts text with real content", async () => {
    await expect(hasMeaningfulKnowledgeContent(
      new File(["# 课堂观察"], "source.md", { type: "text/markdown" }),
      "text/markdown",
    )).resolves.toBe(true);
  });
});
