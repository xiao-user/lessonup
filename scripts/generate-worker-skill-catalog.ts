import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadNodePlatformSkills } from "../server/agent/skill-registry-node.js";

const output = path.resolve(import.meta.dirname, "../cloudflare/worker-skill-catalog.ts");
const skills = await loadNodePlatformSkills();

const source = [
  "// Generated from server/agent/skills by scripts/generate-worker-skill-catalog.ts.",
  "import type { PlatformSkill } from \"../server/agent/skill-registry.js\";",
  "",
  `export const workerPlatformSkills: PlatformSkill[] = ${JSON.stringify(skills, null, 2)};`,
  "",
].join("\n");

await writeFile(output, source, "utf8");
