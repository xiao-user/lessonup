import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PlatformSkill } from "../../agent/skill-registry.js";

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: null,
});

/**
 * Returns the pinned instructions for a Skill that is in this turn's catalog.
 * The system prompt only advertises the catalog; the model must call this
 * before writing from a Skill.
 */
export function createPiReadSkillTool(skills: PlatformSkill[]): AgentTool<any> {
  const catalog = new Map(skills.map((skill) => [`${skill.id}@${skill.version}`, skill]));
  return {
    name: "read_skill",
    label: "读取 Skill 全文",
    description: "读取本轮目录中已钉定版本的 Skill 完整 instructions。未读取全文前不得按该 Skill 写作。",
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      version: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, input) => {
      const parameters = input as { id?: string; version?: string };
      const skill = catalog.get(`${parameters.id}@${parameters.version}`);
      if (!skill) {
        return textResult({
          error: "skill_unavailable",
          message: "该 Skill 不在本轮目录，或版本未钉定。",
        });
      }
      return textResult({
        id: skill.id,
        version: skill.version,
        instructions: skill.instructions,
      });
    },
  };
}
