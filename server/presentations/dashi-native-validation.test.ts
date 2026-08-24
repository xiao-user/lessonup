import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("LessonUp Dashi native validation boundary", () => {
  it("does not turn editorial layout preferences into generation failures", () => {
    const validator = fileURLToPath(new URL(
      "../agent/skills/dashi-ppt/project/scripts/validate-goal-spec.mjs",
      import.meta.url,
    ));
    const source = [
      `import { validateGoalSpec } from ${JSON.stringify(validator)};`,
      "const errors = validateGoalSpec({themePack:'theme02',slides:[",
      "{layout:'theme02_page001',props:{title:'同一核心问题'}},",
      "{layout:'theme02_page001',props:{title:'同一核心问题'}},",
      "{layout:'theme02_page005',props:{title:'同一核心问题'}}]});",
      "console.log(JSON.stringify(errors));",
    ].join("");
    const errors = JSON.parse(execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      source,
    ], { encoding: "utf8" })) as string[];

    expect(errors.filter((error) => /duplicate layout|only one cover|repeated (?:visible|core) copy|cover-like layouts/.test(error))).toEqual([]);
  });
});
