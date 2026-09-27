import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { dashiPiSkillInstructions } from "../server/presentations/dashi-pi-skill.js";

const root = path.resolve(import.meta.dirname, "../server/agent/skills");
const output = path.resolve(import.meta.dirname, "../cloudflare/worker-skill-catalog.ts");
const dashiPackage = JSON.parse(
  await readFile(path.join(root, "dashi-ppt", "project", "package.json"), "utf8"),
) as { version: string };

const skills = await Promise.all((await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== "dashi-ppt")
  .map(async (entry) => {
    const directory = path.join(root, entry.name);
    const manifest = YAML.parse(await readFile(path.join(directory, "manifest.yaml"), "utf8")) as {
      id: string;
      version: string;
      description: string;
      requiredTools?: string[];
      requiredMcp?: string[];
    };
    return {
      id: manifest.id,
      version: manifest.version,
      description: manifest.description,
      requiredTools: manifest.requiredTools ?? [],
      requiredMcp: manifest.requiredMcp ?? [],
      instructions: await readFile(path.join(directory, "SKILL.md"), "utf8"),
    };
  }));

skills.push({
  id: "dashi-ppt",
  version: dashiPackage.version,
  description: "Generate editable HTML presentation decks",
  requiredTools: ["query_dashi_layouts", "inspect_dashi_layouts", "propose_classroom_presentation"],
  requiredMcp: [],
  instructions: dashiPiSkillInstructions,
});
skills.sort((left, right) => left.id.localeCompare(right.id));

const source = [
  "// Generated from server/agent/skills by scripts/generate-worker-skill-catalog.ts.",
  "import type { PlatformSkill } from \"../server/agent/skill-registry.js\";",
  "",
  `export const workerPlatformSkills: PlatformSkill[] = ${JSON.stringify(skills, null, 2)};`,
  "",
].join("\n");

await writeFile(output, source, "utf8");
