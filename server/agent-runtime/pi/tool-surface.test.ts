import { describe, expect, it, vi } from "vitest";
import type { LessonAgentContext, SemesterFrameworkAgentContext } from "../../domain.js";
import { deterministicCapabilityPlan } from "../../agent/capability-router.js";
import { SkillRegistry } from "../../agent/skill-registry.js";
import { MemoryLessonRepository } from "../../repositories/memory-repository.js";
import { UnavailableWebSearchProvider } from "../../providers/unavailable-web-search.js";
import { resolveTurn } from "../../conversation/turn-resolver.js";
import { PiToolSurface } from "./tool-surface.js";

const lessonContext: LessonAgentContext = {
  resourceType: "lesson_file", userId: "teacher", notebookId: "notebook", lessonFileId: "lesson",
  threadId: "thread", branchId: "branch", runId: "run", activeSectionId: "process",
  documentVersion: 0, designBasisVersion: 0, contextProfile: {},
  allowedKnowledgeScopes: ["public", "user:teacher", "notebook:notebook", "file:lesson"],
  attachmentSourceIds: [], abortSignal: new AbortController().signal,
};

const semesterContext: SemesterFrameworkAgentContext = {
  resourceType: "semester_framework", userId: "teacher", notebookId: "notebook", semesterFrameworkId: "framework",
  threadId: "thread", branchId: "branch", runId: "run", frameworkVersion: 0, contextProfile: {},
  allowedKnowledgeScopes: ["public", "user:teacher", "notebook:notebook"],
  attachmentSourceIds: [], abortSignal: new AbortController().signal,
};

function fixture() {
  const repository = new MemoryLessonRepository();
  const surface = new PiToolSurface(repository, new SkillRegistry(), new UnavailableWebSearchProvider(), null);
  return { repository, surface };
}

describe("stable teaching capabilities", () => {
  it("keeps schemas identical across analysis, local edits and curriculum/feedback investigations", () => {
    const { surface } = fixture();
    const schemas = [
      "教学过程写得怎么样？", "请调整这一处", "课标有哪些要求？", "课堂反馈提示什么问题？", "请从第二意见角度检查目标和评价。",
    ].map((message) => {
      const plan = deterministicCapabilityPlan(message);
      const turn = resolveTurn({ plan });
      const tools = surface.toolsForLesson(lessonContext, plan, [], turn.toolSurface).tools;
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "read_lesson_design_basis", "read_lesson_class_feedback", "search_knowledge", "search_curriculum_standards", "propose_document_patch",
      ]));
      expect(tools.map((tool) => tool.name)).not.toContain("read_skill");
      return JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
    });
    expect(new Set(schemas).size).toBe(1);
  });

  it("persists a delegated theme through the surface and restores its immutable planning contract", async () => {
    const repository = new MemoryLessonRepository();
    const dashi = {
      queryLayouts: vi.fn(async () => ({ layouts: [{ layout: "theme10_page001" }] })),
      inspectLayouts: vi.fn(),
      prepareGoal: vi.fn(),
    };
    const surface = new PiToolSurface(repository, new SkillRegistry(), new UnavailableWebSearchProvider(), dashi as never);
    const plan = { ...deterministicCapabilityPlan("生成课堂演示"), presentationRequested: true, presentationThemeConfirmationRequired: false };
    const persisted = vi.fn();
    const delegated = surface.toolsForLesson(lessonContext, plan, [], "write", "seed", "zh", persisted);
    await delegated.tools.find(t => t.name === "query_dashi_layouts")!.execute("choose", { theme: "theme10", queries: [{ intent: "原文" }] });
    expect(persisted).toHaveBeenCalledExactlyOnceWith("theme10");
    expect(delegated.getTerminalPlanningError()).toBeNull();
    const resumed = surface.toolsForLesson(lessonContext, { ...plan, confirmedPresentationTheme: "theme10" }, [], "write", "seed", "zh", persisted);
    const query = resumed.tools.find(t => t.name === "query_dashi_layouts")!;
    await expect(query.execute("drift", { theme: "theme11", queries: [{ intent: "原文" }] })).rejects.toThrow("presentation_theme_mismatch");
    await query.execute("resume", { queries: [{ intent: "原文" }] });
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(dashi.queryLayouts).toHaveBeenCalledTimes(2);
    expect(delegated.hasWriteAttempt()).toBe(false);
    expect(surface.toolsForSemester(semesterContext, deterministicCapabilityPlan("检查学期安排"), "read").getTerminalPlanningError()).toBeNull();
  });

  it("keeps terminal Dashi planning errors observable after tools reject", async () => {
    const surface = new PiToolSurface(new MemoryLessonRepository(), new SkillRegistry(), new UnavailableWebSearchProvider(), {
      queryLayouts: vi.fn(), inspectLayouts: vi.fn(),
    } as never);
    const plan = { ...deterministicCapabilityPlan("生成课堂演示"), presentationRequested: true, presentationThemeConfirmationRequired: false };
    const bundle = surface.toolsForLesson(lessonContext, plan, [], "write");
    const query = bundle.tools.find(t => t.name === "query_dashi_layouts")!;
    await expect(query.execute("first", { queries: [{ intent: "原文" }] })).rejects.toThrow("presentation_theme_required");
    await expect(query.execute("second", { queries: [{ intent: "原文" }] })).rejects.toThrow("presentation_planning_blocked");
    expect(bundle.getTerminalPlanningError()?.message).toBe("presentation_planning_blocked");
  });

  it("keeps the semester proposal visible but rejects consultation writes before any repository work", async () => {
    const { surface, repository } = fixture();
    const read = vi.spyOn(repository, "getSemesterFramework");
    const plan = deterministicCapabilityPlan("只分析当前学期安排，不修改。");
    const tools = surface.toolsForSemester(semesterContext, plan, "read");
    const proposal = tools.tools.find((tool) => tool.name === "propose_semester_framework_patch")!;
    await expect(proposal.execute("call", {})).rejects.toThrow("write_not_requested");
    expect(tools.getProposal()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
