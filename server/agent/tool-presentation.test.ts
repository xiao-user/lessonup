import { describe, expect, it } from "vitest";
import { DashiPlanningError, isTerminalDashiPlanningError, safeDashiPlanningError } from "../presentations/dashi-planning-errors.js";

import {
  safeToolCompletionDetail,
  safeToolDetail,
  safeToolPresentation,
} from "./tool-presentation.js";

describe("safeToolPresentation", () => {
  it("normalizes presentation generation without exposing ids or job parameters", () => {
    expect(safeToolPresentation("create_classroom_presentation", {
      direction: "用更轻快的风格强调观察任务",
    })).toEqual({
      label: "创建课堂演示",
      groupKey: "presentation-create",
    });
  });

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
    expect(safeToolPresentation("search_curriculum_standards", {
      query: "当前课题与实际知识点",
    })).toEqual({
      label: "检索当前学科课标",
      groupKey: "curriculum-read",
    });
  });
});

describe("safeToolDetail", () => {
  it("describes a known document read without exposing private arguments", () => {
    const detail = safeToolDetail("read_section", {
      field: "objectives",
      sourceId: "private-source-id",
    });
    expect(detail).toBe("读取教学目标的当前内容，作为后续分析与修改依据。");
    expect(detail).not.toContain("private-source-id");
  });

  it("provides a truthful fallback without exposing raw tool output", () => {
    const detail = safeToolDetail("custom_teacher_tool", {
      prompt: "private prompt",
      result: "private result",
    });
    expect(detail).toBe("使用已授权的备课能力处理当前任务。");
    expect(detail).not.toContain("private");
  });
});

describe("safeToolCompletionDetail", () => {
  it("keeps the factual start description instead of narrating the agent loop", () => {
    const started = safeToolDetail("read_document", {});
    expect(safeToolCompletionDetail("read_document", "读取整份教案", false, started)).toBe(started);
    expect(safeToolCompletionDetail("read_document", "读取整份教案")).toBe(
      "读取当前教案的完整内容，作为后续分析与修改依据。",
    );
    expect(safeToolCompletionDetail("read_document", "读取整份教案")).not.toMatch(/Pi/);
  });

  it("shows actionable safe Dashi business failures without copying raw exception text", () => {
    expect(safeToolCompletionDetail("query_dashi_layouts", "查询版式", true, undefined, "presentation_theme_required")).toBe("尚未选定演示主题，请选择主题或让助手选择后继续。");
    expect(safeToolCompletionDetail("inspect_dashi_layouts", "检查版式", true, undefined, new DashiPlanningError("presentation_theme_mismatch"))).toContain("已有固定主题");
    expect(safeToolCompletionDetail("propose_classroom_presentation", "准备演示", true, undefined, "presentation_planning_blocked")).toContain("本轮已停止");
    for (const unsafe of [new Error("SQL bearer secret"), "presentation_theme_required: SQL bearer secret", "constructor", { message: "presentation_theme_required", private: "secret" }]) {
      expect(safeDashiPlanningError(unsafe)).toBeNull();
      expect(safeToolCompletionDetail("query_dashi_layouts", "查询版式", true, undefined, unsafe)).toBe("查询版式未完成。");
    }
    expect(safeToolCompletionDetail("read_document", "读取教案", true, undefined, "presentation_theme_required")).toBe("读取教案未完成。");
    expect(isTerminalDashiPlanningError(new DashiPlanningError("presentation_theme_binding_failed"))).toBe(true);
    expect(isTerminalDashiPlanningError("presentation_planning_blocked")).toBe(true);
    expect(isTerminalDashiPlanningError("presentation_theme_required")).toBe(false);
    expect(isTerminalDashiPlanningError(new Error("private backend failure"))).toBe(false);
  });

  it("distinguishes a proposal preflight failure", () => {
    expect(safeToolCompletionDetail("propose_document_patch", "准备修改建议", true)).toBe(
      "修改建议未通过预检，可在本轮根据问题继续调整。",
    );
  });
});
