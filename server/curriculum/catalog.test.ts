import { describe, expect, it } from "vitest";
import {
  buildCurriculumFacets,
  buildCurriculumOutline,
  filterCurriculumTextbooks,
  formatCurriculumOutlineTree,
  formatTextbookEditionLabel,
  searchCurriculumNodeRecords,
} from "./catalog.js";
import {
  curriculumFixtureNodes,
  curriculumFixtureTextbooks,
} from "../testing/curriculum-fixture.js";

describe("curriculum catalog helpers", () => {
  it("filters textbooks by taxonomy and query", () => {
    const matched = filterCurriculumTextbooks(curriculumFixtureTextbooks, {
      stage: "高中",
      subject: "数学",
      query: "北师大",
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.id).toBe("textbook-math-bnu");
  });

  it("builds facets and edition labels for create flows", () => {
    const facets = buildCurriculumFacets(curriculumFixtureTextbooks);
    expect(facets.subjects).toEqual(["数学", "信息技术"]);
    expect(formatTextbookEditionLabel(curriculumFixtureTextbooks[1])).toContain("北师大版");
  });

  it("builds a level-limited outline and formats indentation", () => {
    const nodes = buildCurriculumOutline(
      curriculumFixtureNodes.filter((node) => node.textbookId === "textbook-math-bnu"),
      { maxLevel: 2 },
    );
    expect(nodes.map((node) => node.title)).toEqual([
      "第一章 三角函数",
      "第二章 平面向量及其应用",
      "1 周期变化",
    ]);

    const tree = formatCurriculumOutlineTree(nodes);
    expect(tree[0]?.title).toBe("第一章 三角函数");
    expect(tree.some((row) => row.title.startsWith("  1 周期变化"))).toBe(true);
    expect(tree.some((row) => row.title.includes("习题1-1"))).toBe(false);
  });

  it("returns and formats the full subtree below a selected parent", () => {
    const source = curriculumFixtureNodes.filter(
      (node) => node.textbookId === "textbook-math-bnu",
    );
    const nodes = buildCurriculumOutline(source, { parentId: "ch1", maxLevel: 3 });
    expect(nodes.map((node) => node.nodeId)).toEqual(["ch1-1", "ch1-1-1"]);
    expect(formatCurriculumOutlineTree(nodes, { rootParentId: "ch1" })
      .map((node) => node.title)).toEqual(["1 周期变化", "  习题1-1"]);
  });

  it("searches node titles and returns their complete catalog path", () => {
    const matches = searchCurriculumNodeRecords({
      textbooks: curriculumFixtureTextbooks,
      nodes: curriculumFixtureNodes,
      query: "《周期变化》",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path.map((node) => node.title)).toEqual([
      "第一章 三角函数",
      "1 周期变化",
    ]);
  });
});
