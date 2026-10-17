import { readFile } from "node:fs/promises";
import { z } from "zod";
import { dashiPiSkillInstructions } from "../presentations/dashi-pi-skill.js";
import { SkillRegistry, type PlatformSkill } from "./skill-registry.js";

/** Dashi is the only separately versioned Skill. Teaching policy is built in. */
export async function loadNodePlatformSkills(): Promise<PlatformSkill[]> {
  const source = await readFile(new URL("./skills/dashi-ppt/project/package.json", import.meta.url), "utf8");
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(source));
  return [{
    id: "dashi-ppt",
    version,
    description: "Generate editable HTML presentation decks",
    requiredTools: ["query_dashi_layouts", "inspect_dashi_layouts", "propose_classroom_presentation"],
    requiredMcp: [],
    instructions: dashiPiSkillInstructions,
  }];
}

export function createNodeSkillRegistry() {
  return new SkillRegistry(loadNodePlatformSkills);
}
