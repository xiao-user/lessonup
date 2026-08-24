import { describe, expect, it } from "vitest";
import { SkillRegistry } from "./skill-registry.js";

describe("SkillRegistry", () => {
  it("adapts the generic Dashi package to LessonUp's Pi tool boundary", async () => {
    const registry = await new SkillRegistry().load();
    const [skill] = registry.resolve(["dashi-ppt"]);

    expect(skill.instructions).toContain("one content artifact only");
    expect(skill.instructions).toContain("primary language of the teacher's latest message");
    expect(skill.instructions).toContain("propose_classroom_presentation");
    expect(skill.instructions).not.toContain("immutableStoryboard");
    expect(skill.instructions).not.toContain("render_goal_deck.sh");
    expect(skill.instructions).not.toContain("check_latest_version");
  });

  it("keeps full lesson authoring policy server-side", async () => {
    const registry = await new SkillRegistry().load();
    const [skill] = registry.resolve(["lesson-full-authoring"]);

    expect(skill.instructions).toContain("守住当前课时容量与内容边界");
    expect(skill.requiredTools).toEqual(["read_document", "propose_document_patch"]);
  });
});
