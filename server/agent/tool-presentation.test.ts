import { describe, expect, it } from "vitest";

import { safeToolPresentation } from "./tool-presentation.js";

describe("safeToolPresentation", () => {
  it("names a single section without exposing raw tool arguments", () => {
    expect(safeToolPresentation("read_section", '{"field":"objectives"}')).toEqual({
      label: "读取教学目标",
      groupKey: "document-read",
    });
  });

  it("describes one multi-section document read as one task", () => {
    expect(safeToolPresentation("read_document", {
      fields: ["objectives", "process", "assessment"],
    })).toEqual({
      label: "读取 3 个教案栏目",
      groupKey: "document-read",
    });
  });

  it("uses the whole lesson label when fields are omitted", () => {
    expect(safeToolPresentation("read_document", {})).toEqual({
      label: "读取整份教案",
      groupKey: "document-read",
    });
  });

  it("labels an attached-source read without exposing its source id", () => {
    expect(safeToolPresentation("read_attached_source", {
      sourceId: "private-source-id",
    })).toEqual({
      label: "读取附带资料",
      groupKey: "knowledge-read",
    });
  });
});
