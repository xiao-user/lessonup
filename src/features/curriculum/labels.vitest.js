import { describe, expect, it } from "vitest";
import {
  buildCurriculumNodeOptions,
  formatCurriculumNodeTitle,
  formatTextbookOptionLabel,
  formatTextbookSelectionLabel,
  formatTextbookVolumeLabel,
} from "./labels.js";

describe("curriculum labels", () => {
  it("uses the source title to distinguish standard and five-four editions", () => {
    const common = {
      edition: "统编版",
      grade: "七年级",
      volume: "上册",
    };
    const standard = formatTextbookOptionLabel({
      ...common,
      title: "义务教育教科书 语文 七年级上册",
    });
    const fiveFour = formatTextbookOptionLabel({
      ...common,
      title: "义务教育教科书（五·四学制）语文 七年级上册",
    });
    expect(standard).not.toBe(fiveFour);
    expect(fiveFour).toContain("五·四学制");
    expect(formatTextbookSelectionLabel({
      ...common,
      stage: "初中（五•四学制）",
      title: "义务教育教科书（五•四学制）语文七年级上册",
    })).toBe("统编版 · 七年级 · 上册 · 五四学制");
    expect(formatTextbookVolumeLabel({
      ...common,
      stage: "初中",
      title: "义务教育教科书语文七年级上册",
    })).toBe("七年级 · 上册");
  });

  it("builds readable descendant paths and clean generated lesson titles", () => {
    const nodes = [
      { nodeId: "reading", parentId: "unit-1", title: "阅读" },
      { nodeId: "lesson-1", parentId: "reading", title: "1 春", pageNumber: 9 },
    ];
    expect(buildCurriculumNodeOptions(nodes, "unit-1")).toEqual([
      expect.objectContaining({ nodeId: "lesson-1", label: "阅读 / 1 春" }),
    ]);
    expect(formatCurriculumNodeTitle("1 春")).toBe("春");
    expect(formatCurriculumNodeTitle("3* 雨的四季")).toBe("雨的四季");
  });
});
