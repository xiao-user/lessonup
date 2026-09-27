import { describe, expect, it } from "vitest";
import { createPiReadSkillTool } from "./skill-tools.js";

const catalogSkill = {
  id: "lesson-full-authoring",
  version: "1.0.0",
  description: "完整编写教案",
  instructions: "守住当前课时容量与内容边界。",
  requiredTools: ["read_document", "propose_document_patch"],
  requiredMcp: [],
};

describe("read_skill", () => {
  it("returns the pinned instructions for a catalog skill", async () => {
    const tool = createPiReadSkillTool([catalogSkill]);
    const result = await tool.execute("call-1", { id: "lesson-full-authoring", version: "1.0.0" });
    expect(JSON.parse(result.content[0] && "text" in result.content[0] ? result.content[0].text : "{}"))
      .toMatchObject({
        id: "lesson-full-authoring",
        version: "1.0.0",
        instructions: catalogSkill.instructions,
      });
  });

  it("returns a recoverable error for an unselected skill or wrong version", async () => {
    const tool = createPiReadSkillTool([catalogSkill]);
    const missing = await tool.execute("call-2", { id: "dashi-ppt", version: "1.0.0" });
    const wrongVersion = await tool.execute("call-3", { id: "lesson-full-authoring", version: "9.9.9" });
    expect(JSON.parse(missing.content[0] && "text" in missing.content[0] ? missing.content[0].text : "{}"))
      .toMatchObject({ error: "skill_unavailable" });
    expect(JSON.parse(wrongVersion.content[0] && "text" in wrongVersion.content[0] ? wrongVersion.content[0].text : "{}"))
      .toMatchObject({ error: "skill_unavailable" });
  });
});
