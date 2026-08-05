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

  it("presents design-basis projection as one A4 write task", () => {
    expect(safeToolPresentation("propose_design_basis_projection", {
      operations: [{
        field: "assessment",
        basisEntryIds: ["private-entry-id"],
      }],
    })).toEqual({
      label: "准备将设计依据落实到教案",
      groupKey: "document-write",
    });
  });

  it("presents a complete lesson change as one teacher-facing task", () => {
    expect(safeToolPresentation("propose_lesson_design_change", {
      designBasisOperations: [{ referenceKey: "hidden-reference" }],
      documentOperations: [{ field: "assessment" }],
    })).toEqual({
      label: "准备完整备课调整",
      groupKey: "document-write",
    });
  });

  it("labels curriculum catalog tools without exposing textbook ids", () => {
    expect(safeToolPresentation("lookup_curriculum_textbooks", {
      subject: "语文",
    })).toEqual({
      label: "查找教材书目",
      groupKey: "curriculum-read",
    });
    expect(safeToolPresentation("read_curriculum_outline", {
      textbookId: "secret-id",
    })).toEqual({
      label: "读取教材目录",
      groupKey: "curriculum-read",
    });
    expect(safeToolPresentation("read_curriculum_node_semantics", {
      textbookId: "secret-id",
      nodeId: "secret-node-id",
    })).toEqual({
      label: "读取章节学习要点",
      groupKey: "curriculum-read",
    });
    expect(safeToolPresentation("trace_curriculum_learning_path", {
      entityId: "secret-entity-id",
    })).toEqual({
      label: "梳理前后学习路径",
      groupKey: "curriculum-read",
    });
    expect(safeToolPresentation("read_curriculum_knowledge_points", {
      textbookId: "secret-id",
      nodeId: "secret-node-id",
    })).toEqual({
      label: "读取章节知识点",
      groupKey: "curriculum-read",
    });
    expect(safeToolPresentation("search_curriculum_knowledge_points", {
      textbookId: "secret-id",
      query: "比喻",
    })).toEqual({
      label: "检索相关知识点",
      groupKey: "curriculum-read",
    });
    expect(safeToolPresentation("read_curriculum_knowledge_continuity", {
      textbookId: "secret-id",
      currentNodeId: "secret-node-id",
      entityId: "secret-entity-id",
    })).toEqual({
      label: "核对知识连续性",
      groupKey: "curriculum-read",
    });
  });
});
