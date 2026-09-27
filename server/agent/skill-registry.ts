export type PlatformSkill = {
  id: string;
  version: string;
  description: string;
  requiredTools: string[];
  requiredMcp: string[];
  instructions: string;
};

type SkillLoader = () => Promise<PlatformSkill[]>;

export class SkillRegistry {
  private skills = new Map<string, PlatformSkill>();

  constructor(private readonly loader: SkillLoader = async () => []) {}

  async load() {
    for (const skill of await this.loader()) this.register(skill);
    return this;
  }

  register(skill: PlatformSkill) {
    this.skills.set(`${skill.id}@${skill.version}`, skill);
  }

  resolve(ids: string[]) {
    return ids.map((id) => {
      const skill = this.listLatest().find((item) => item.id === id);
      if (!skill) throw new Error(`skill_not_found:${id}`);
      return skill;
    });
  }

  /**
   * Latest pinned version of every registered Skill, sorted by id so the
   * system-prompt catalog is byte-identical across turns.
   */
  listLatest() {
    const latest = new Map<string, PlatformSkill>();
    for (const skill of this.skills.values()) {
      const current = latest.get(skill.id);
      if (!current || skill.version.localeCompare(current.version) > 0) latest.set(skill.id, skill);
    }
    return [...latest.values()].sort((left, right) => left.id.localeCompare(right.id));
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
