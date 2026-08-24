import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { dashiPiSkillInstructions } from "../presentations/dashi-pi-skill.js";

const skillManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  requiredTools: z.array(z.string()).default([]),
  requiredMcp: z.array(z.string()).default([]),
});

const openAiSkillManifestSchema = z.object({
  interface: z.object({
    short_description: z.string(),
  }),
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
      try {
        const manifestSource = await readFile(path.join(root, "manifest.yaml"), "utf8");
        const manifest = skillManifestSchema.parse(YAML.parse(manifestSource));
        const instructions = await readFile(path.join(root, "SKILL.md"), "utf8");
        this.skills.set(`${manifest.id}@${manifest.version}`, { ...manifest, instructions });
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        // Officially installed third-party Skills use agents/openai.yaml rather
        // than LessonUp's platform manifest. Register Dashi without changing
        // any file in the installed package; the Function Tool executes its
        // original scripts on the Agent's behalf.
        const [openAiSource, packageSource] = await Promise.all([
          readFile(path.join(root, "agents", "openai.yaml"), "utf8"),
          readFile(path.join(root, "project", "package.json"), "utf8"),
        ]);
        const openAiManifest = openAiSkillManifestSchema.parse(YAML.parse(openAiSource));
        const packageManifest = z.object({ version: z.string() }).parse(JSON.parse(packageSource));
        const skill: PlatformSkill = {
          id: directory.name,
          version: packageManifest.version,
          description: openAiManifest.interface.short_description,
          requiredTools: ["query_dashi_layouts", "inspect_dashi_layouts", "propose_classroom_presentation"],
          requiredMcp: [],
          instructions: dashiPiSkillInstructions,
        };
        this.skills.set(`${skill.id}@${skill.version}`, skill);
      }
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
