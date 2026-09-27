import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { dashiPiSkillInstructions } from "../presentations/dashi-pi-skill.js";
import { SkillRegistry, type PlatformSkill } from "./skill-registry.js";

const skillManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  requiredTools: z.array(z.string()).default([]),
  requiredMcp: z.array(z.string()).default([]),
});

const openAiSkillManifestSchema = z.object({
  interface: z.object({ short_description: z.string() }),
});

const skillsRoot = fileURLToPath(new URL("./skills", import.meta.url));

/** Node-only loader for the local development runtime and native Dashi host. */
export async function loadNodePlatformSkills(): Promise<PlatformSkill[]> {
  const skills: PlatformSkill[] = [];
  const directories = await readdir(skillsRoot, { withFileTypes: true });
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const root = path.join(skillsRoot, directory.name);
    try {
      const manifestSource = await readFile(path.join(root, "manifest.yaml"), "utf8");
      const manifest = skillManifestSchema.parse(YAML.parse(manifestSource));
      const instructions = await readFile(path.join(root, "SKILL.md"), "utf8");
      skills.push({ ...manifest, instructions });
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const [openAiSource, packageSource] = await Promise.all([
        readFile(path.join(root, "agents", "openai.yaml"), "utf8"),
        readFile(path.join(root, "project", "package.json"), "utf8"),
      ]);
      const openAiManifest = openAiSkillManifestSchema.parse(YAML.parse(openAiSource));
      const packageManifest = z.object({ version: z.string() }).parse(JSON.parse(packageSource));
      skills.push({
        id: directory.name,
        version: packageManifest.version,
        description: openAiManifest.interface.short_description,
        requiredTools: ["query_dashi_layouts", "inspect_dashi_layouts", "propose_classroom_presentation"],
        requiredMcp: [],
        instructions: dashiPiSkillInstructions,
      });
    }
  }
  return skills;
}

export function createNodeSkillRegistry() {
  return new SkillRegistry(loadNodePlatformSkills);
}
