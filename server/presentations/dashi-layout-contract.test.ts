import { describe, expect, it } from "vitest";
import type { DashiGoal } from "./dashi-goal.js";
import {
  assertDashiGoalHasCompleteVisibleCopy,
  indexDashiLayoutContracts,
  keepOnlyDashiAuthoredContent,
} from "./dashi-layout-contract.js";

const contract = {
  layout: "theme09_page008",
  copyKeys: [
    "heading",
    "bars[].label",
    "bars[].pct",
    "stats[].value",
    "tags[]",
    "barsSectionLabel",
  ],
  fillPlan: {
    text: [{ key: "heading" }, { key: "barsSectionLabel" }],
    arrays: [
      { key: "bars", visibleCount: 4, countKey: null },
      { key: "stats", visibleCount: 4, countKey: "statCount" },
      { key: "tags", visibleCount: 5, countKey: null },
    ],
  },
  mediaSlots: [],
};

function goal(props: Record<string, unknown>): DashiGoal {
  return {
    title: "课堂演示",
    goal: "分析表达效果",
    themePack: "theme09",
    slides: [{ layout: "theme09_page008", props }],
  };
}

describe("Dashi inspected layout copy contract", () => {
  it("indexes both single and batch inspection responses", () => {
    expect(indexDashiLayoutContracts(contract).has(contract.layout)).toBe(true);
    expect(indexDashiLayoutContracts({ layouts: [contract] }).has(contract.layout)).toBe(true);
  });

  it("rejects a goal that would fall back to unrelated template copy", () => {
    expect(() => assertDashiGoalHasCompleteVisibleCopy(goal({
      heading: "三步分析法",
      stats: [
        { value: "①" },
        { value: "②" },
        { value: "③" },
      ],
      statCount: 3,
      tags: ["动作/情态", "景物特点", "作者情感"],
    }), indexDashiLayoutContracts(contract))).toThrow(/props\.bars\[\]\.label:visible_copy_required/);
  });

  it("accepts explicitly authored concise arrays without forcing template counts", () => {
    expect(() => assertDashiGoalHasCompleteVisibleCopy(goal({
      heading: "证据如何支持结论",
      barsSectionLabel: "证据强度",
      bars: [{ label: "动作", pct: 50 }, { label: "情态", pct: 50 }],
      statCount: 3,
      stats: [{ value: "①" }, { value: "②" }, { value: "③" }],
      tags: ["圈画", "解释", "验证"],
    }), indexDashiLayoutContracts(contract))).not.toThrow();
  });

  it("keeps classroom content and structural counts but drops visual controls", () => {
    const normalized = keepOnlyDashiAuthoredContent(goal({
      heading: "三步分析法",
      barsSectionLabel: "证据强度",
      bars: [{ label: "动作", pct: 50 }],
      statCount: 3,
      showIndex: true,
      showStepNo: true,
    }), indexDashiLayoutContracts(contract));

    expect(normalized.slides[0]?.props).toEqual({
      heading: "三步分析法",
      barsSectionLabel: "证据强度",
      bars: [{ label: "动作", pct: 50 }],
      statCount: 3,
    });
  });

  it("binds template counts to authored array lengths so runtime defaults cannot leak", () => {
    const contracts = new Map([["theme01_page027", {
      layout: "theme01_page027",
      copyKeys: ["items[].title"],
      fillPlan: {
        text: [],
        arrays: [{ key: "items", countKey: "itemCount", visibleCount: 4 }],
      },
      mediaSlots: [],
    }]]);
    const normalized = keepOnlyDashiAuthoredContent({
      title: "课堂演示",
      goal: "分析表达效果",
      themePack: "theme01",
      slides: [{
        layout: "theme01_page027",
        props: {
          items: [{ title: "为什么怀念" }, { title: "线索是什么" }],
          itemCount: 4,
        },
      }],
    }, contracts);

    expect(normalized.slides[0]?.props).toEqual({
      items: [{ title: "为什么怀念" }, { title: "线索是什么" }],
      itemCount: 2,
    });
  });
});
