import { describe, expect, it } from "vitest";
import { createNodeSkillRegistry } from "./skill-registry-node.js";

describe("SkillRegistry", () => {
  it("adapts the generic Dashi package to LessonUp's Pi tool boundary", async () => {
    const registry = await createNodeSkillRegistry().load();
    const [skill] = registry.resolve(["dashi-ppt"]);

    expect(skill.instructions).toContain("one content artifact only");
    expect(skill.instructions).toContain("primary language of the teacher's latest message");
    expect(skill.instructions).toContain("propose_classroom_presentation");
    expect(skill.instructions).not.toContain("immutableStoryboard");
    expect(skill.instructions).not.toContain("render_goal_deck.sh");
    expect(skill.instructions).not.toContain("check_latest_version");
  });

  it("lists the latest Skill of each id in a stable catalog order", async () => {
    const registry = await createNodeSkillRegistry().load();
    const catalog = registry.listLatest();
    expect(catalog.map((skill) => skill.id)).toEqual([...catalog.map((skill) => skill.id)].sort());
    expect(catalog.map((skill) => skill.id)).toEqual(["dashi-ppt"]);
    expect(catalog.map((skill) => skill.id)).toContain("dashi-ppt");
  });
});
