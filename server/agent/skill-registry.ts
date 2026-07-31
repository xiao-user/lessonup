import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

const skillManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  requiredTools: z.array(z.string()).default([]),
  requiredMcp: z.array(z.string()).default([]),
});

export type PlatformSkill = z.infer<typeof skillManifestSchema> & { instructions: string };

const skillsRoot = fileURLToPath(new URL("./skills", import.meta.url));

export class SkillRegistry {
  private skills = new Map<string, PlatformSkill>();

  async load() {
    const directories = await readdir(skillsRoot, { withFileTypes: true });
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const root = path.join(skillsRoot, directory.name);
      const [manifestSource, instructions] = await Promise.all([
        readFile(path.join(root, "manifest.yaml"), "utf8"),
        readFile(path.join(root, "SKILL.md"), "utf8"),
      ]);
      const manifest = skillManifestSchema.parse(YAML.parse(manifestSource));
      this.skills.set(`${manifest.id}@${manifest.version}`, { ...manifest, instructions });
    }
    return this;
  }

  resolve(ids: string[]) {
    return ids.map((id) => {
      const matches = [...this.skills.values()].filter((skill) => skill.id === id);
      if (!matches.length) throw new Error(`skill_not_found:${id}`);
      return matches.sort((left, right) => right.version.localeCompare(left.version))[0];
    });
  }

  resolveVersions(versions: Record<string, string>) {
    return Object.entries(versions).map(([id, version]) => {
      const skill = this.skills.get(`${id}@${version}`);
      if (!skill) throw new Error(`skill_version_unavailable:${id}@${version}`);
      return skill;
    });
  }

  get versionMap() {
    return Object.fromEntries([...this.skills.values()].map((skill) => [skill.id, skill.version]));
  }
}
