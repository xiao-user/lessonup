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

  it("keeps full lesson authoring policy server-side", async () => {
    const registry = await createNodeSkillRegistry().load();
    const [skill] = registry.resolve(["lesson-full-authoring"]);

    expect(skill.instructions).toContain("守住当前课时容量与内容边界");
    expect(skill.instructions).toContain("重要性是突出显示的首要依据");
    expect(skill.instructions).toContain("不以内容是否藏在长段落里、是否容易被漏读为前提");
    expect(skill.instructions).toContain("重要内容应得到恰当突出，但不必每处都涂色");
    expect(skill.instructions).toContain("不规定标题数量、标记数量、密度、每栏必标或颜色与教学类别的固定对应");
    expect(skill.instructions).toContain("不要把每条目标或每个要点都包装成“标题＋解释”");
    expect(skill.instructions).toContain("某段、某栏乃至整份教案可以没有小标题或笔迹标记");
    expect(skill.version).toBe("1.1.1");
    expect(skill.requiredTools).toEqual(["read_document", "propose_document_patch"]);
  });

  it("lists the latest Skill of each id in a stable catalog order", async () => {
    const registry = await createNodeSkillRegistry().load();
    const catalog = registry.listLatest();
    expect(catalog.map((skill) => skill.id)).toEqual([...catalog.map((skill) => skill.id)].sort());
    expect(catalog.map((skill) => skill.id)).toContain("lesson-full-authoring");
    expect(catalog.map((skill) => skill.id)).toContain("dashi-ppt");
  });
});
