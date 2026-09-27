import { describe, expect, it } from "vitest";
import { validateDeck } from "./core/schema.js";
import { browserDeckToGoal, goalToBrowserDeck } from "./goal-to-deck.js";
import { sampleDeck } from "./sample-deck.js";

describe("Dashi browser deck conversion", () => {
  it("validates the bundled sample deck", () => {
    const result = validateDeck(sampleDeck);
    expect(result.ok).toBe(true);
    expect(result.deck?.theme).toBe("theme01");
  });

  it("turns a Dashi goal into a mountable deck spec", () => {
    const result = validateDeck(goalToBrowserDeck({
      title: "课题 · 课堂演示",
      themePack: "theme07",
      slides: [{ layout: "theme07_page001", props: { title: "课题" } }],
    }, { id: "demo" }));
    expect(result.ok).toBe(true);
    expect(result.deck?.slides[0]?.variants[0]?.props).toEqual({ title: "课题" });
    expect(result.deck?.slides[0]?.content).toEqual({ title: "课题" });
    expect(result.deck?.slides[0]?.variants[0]?.contentMap).toEqual({ title: "title" });
  });

  it("round-trips canonical browser edits into the persisted Dashi goal", () => {
    const goal = {
      title: "课题 · 课堂演示",
      goal: "课堂目标",
      themePack: "theme07",
      slides: [{
        layout: "theme07_page006",
        props: { title: "原题", items: [{ label: "原内容" }] },
      }],
    };
    const deck = validateDeck(goalToBrowserDeck(goal, { id: "demo" })).deck;
    deck.slides[0].content.title = "修改后的课题";
    deck.slides[0].content.items[0].label = "修改后的内容";

    expect(browserDeckToGoal(deck, goal).slides[0]).toEqual({
      layout: "theme07_page006",
      props: { title: "修改后的课题", items: [{ label: "修改后的内容" }] },
    });
  });
});
