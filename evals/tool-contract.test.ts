import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LessonAgentContext, SemesterFrameworkAgentContext } from "../server/domain.js";
import { deterministicCapabilityPlan } from "../server/agent/capability-router.js";
import { SkillRegistry } from "../server/agent/skill-registry.js";
import { MemoryLessonRepository } from "../server/repositories/memory-repository.js";
import { PiToolSurface } from "../server/agent-runtime/pi/tool-surface.js";
import { resolveTurn } from "../server/conversation/turn-resolver.js";

type Case = { id: string; prompt: string; resourceType?: string; requiredTools?: string[]; requiredAnyTools?: string[] };
const cases: Case[] = readFileSync(new URL("./cases.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("live evaluation tool contracts", () => {
  it.each(cases)("$id only requires tools exposed by the native Pi runtime", (testCase) => {
    // Schema construction does not perform I/O. Include the optional configured
    // web surface so an eval can require it without making network requests.
    const surface = new PiToolSurface(new MemoryLessonRepository(), new SkillRegistry(),
      { search: async () => [], open: async (url) => ({ url, content: "" }) }, null);
    const plan = deterministicCapabilityPlan(testCase.prompt);
    const turn = resolveTurn({ plan });
    const tools = testCase.resourceType === "semester_framework"
      ? surface.toolsForSemester({} as SemesterFrameworkAgentContext, plan, turn.toolSurface).tools
      : surface.toolsForLesson({ attachmentSourceIds: [] } as unknown as LessonAgentContext, plan, [], turn.toolSurface).tools;
    const names = tools.map((tool) => tool.name);
    for (const required of testCase.requiredTools ?? []) expect(names).toContain(required);
    if (testCase.requiredAnyTools?.length) expect(testCase.requiredAnyTools.some((name) => names.includes(name))).toBe(true);
    expect(names).not.toContain("read_document_metadata");
  });
});
