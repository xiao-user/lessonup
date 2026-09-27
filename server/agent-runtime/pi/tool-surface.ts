import { type CapabilityPlan, type LessonAgentContext, type SemesterFrameworkAgentContext } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { SkillRegistry, type PlatformSkill } from "../../agent/skill-registry.js";
import { type DashiThemeId } from "../../presentations/dashi-theme-catalog.js";
import type { WebSearchProvider } from "../../providers/web-search.js";
import { UnavailableWebSearchProvider } from "../../providers/unavailable-web-search.js";
import { createPiDashiPlanningSession } from "./dashi-tools.js";
import { assertDashiGoalHasCompleteVisibleCopy, indexDashiLayoutContracts, keepOnlyDashiAuthoredContent, type DashiLayoutContract } from "../../presentations/dashi-layout-contract.js";
import { createPiLessonKnowledgeTools, createPiLessonReadTools } from "./lesson-tools.js";
import { createPiDocumentProposalTool, createPiDesignBasisPatchProposalTool, createPiDesignBasisProjectionProposalTool, createPiLessonDesignChangeProposalTool, createPiPresentationProposalTool, createPiSemesterProposalTool, type PiCapturedProposal } from "./proposal-tools.js";
import { createPiSemesterReadTools } from "./semester-tools.js";
import { createPiCurriculumTools } from "./curriculum-tools.js";
import { createPiDesignBasisReadTools } from "./design-basis-tools.js";
import { createPiWebTools } from "./web-tools.js";
import { createPiSpecialistTools } from "./specialist-tools.js";
import { createPiReadSkillTool } from "./skill-tools.js";
import { type ToolSurface } from "../../conversation/turn-resolver.js";
import { type PiDashi } from "./contracts.js";

/** Builds capability-scoped tools and stable skill prefixes; never executes a run. */
export class PiToolSurface {
  constructor(
    private readonly repository: LessonRepository,
    private readonly registry: SkillRegistry,
    private readonly webProvider: WebSearchProvider,
    private readonly dashi: PiDashi | null,
  ) {}
  /**
   * Provider prefix is a session asset. The Skill catalog and ordinary lesson
   * tools stay the same for every turn on this resource; per-turn routing only
   * belongs in the trailing turn context.
   */
  private sessionSkills() {
    return this.registry.listLatest().filter((skill) => skill.id !== "dashi-ppt" || Boolean(this.dashi));
  }

  /** Keep the ordinary Agent Skill prefix stable across read and write turns. */
  skillsForSurface(plan: CapabilityPlan, _surface: ToolSurface) {
    return this.sessionSkills().filter((skill) => {
      if (skill.id === "dashi-ppt" && !plan.presentationRequested) return false;
      return true;
    });
  }

  private sessionWebTools(ownerId: string, runId: string) {
    if (this.webProvider instanceof UnavailableWebSearchProvider) return [];
    return createPiWebTools({
      repository: this.repository,
      provider: this.webProvider,
      ownerId,
      runId,
    });
  }

  toolsForLesson(
    context: LessonAgentContext,
    plan: CapabilityPlan,
    skills: PlatformSkill[],
    surface: ToolSurface,
    presentationSeed?: string,
    presentationLanguage?: "zh" | "en",
  ) {
    const scope = {
      ownerId: context.userId,
      notebookId: context.notebookId,
      lessonFileId: context.lessonFileId,
      runId: context.runId,
      allowedKnowledgeScopes: context.allowedKnowledgeScopes,
      attachmentSourceIds: context.attachmentSourceIds,
    };
    const writing = surface === "write";
    const needsKnowledge = plan.mcpServers.includes("knowledge")
      || context.attachmentSourceIds.length > 0;
    const needsCurriculum = plan.curriculumRequested
      || plan.requiredEvidenceKinds?.some((kind) => kind.startsWith("curriculum_"));
    const needsDesignBasis = plan.designBasisRequested || plan.designBasisWriteRequested;
    // The approval-gated document proposal is part of the stable Agent tool
    // surface. Per-turn policy decides whether it may succeed; removing the
    // schema on consultation turns invalidated the provider's transcript cache.
    const document = createPiDocumentProposalTool({ repository: this.repository, context, plan });
    const tools = [
      ...(skills.length ? [createPiReadSkillTool(skills)] : []),
      ...createPiLessonReadTools(this.repository, scope, {
        requireCompleteDocument: plan.presentationRequested && !plan.presentationThemeConfirmationRequired,
      }),
      ...(needsKnowledge ? createPiLessonKnowledgeTools(this.repository, scope) : []),
      ...(needsCurriculum ? createPiCurriculumTools(this.repository, context) : []),
      ...(needsDesignBasis ? createPiDesignBasisReadTools(this.repository, context) : []),
      ...(plan.mcpServers.includes("web") ? this.sessionWebTools(context.userId, context.runId) : []),
      ...createPiSpecialistTools(this.repository, context, plan),
      document.tool,
    ];
    const captured: Array<() => PiCapturedProposal | null> = [document.getProposal];
    if (writing && plan.designBasisWriteRequested) {
      const basis = createPiDesignBasisPatchProposalTool({ repository: this.repository, context });
      const combined = createPiLessonDesignChangeProposalTool({
        repository: this.repository,
        context,
        plan,
      });
      const projection = createPiDesignBasisProjectionProposalTool({
        repository: this.repository,
        context,
        plan,
      });
      tools.push(basis.tool, combined.tool, projection.tool);
      captured.push(basis.getProposal, combined.getProposal, projection.getProposal);
    }
    if (writing && plan.presentationRequested && this.dashi) {
      const dashi = this.dashi;
      const inspectedLayouts = new Map<string, DashiLayoutContract>();
      const planning = createPiDashiPlanningSession(dashi, {
        theme: plan.confirmedPresentationTheme as DashiThemeId | undefined,
        seed: presentationSeed,
        onLayoutsInspected: (_layouts, result) => {
          for (const [layout, contract] of indexDashiLayoutContracts(result)) {
            inspectedLayouts.set(layout, contract);
          }
        },
      });
      const proposal = createPiPresentationProposalTool({
        repository: this.repository,
        context,
        getTheme: planning.getTheme,
        language: presentationLanguage,
        randomSeed: presentationSeed,
        normalizeGoal: (goal) => keepOnlyDashiAuthoredContent(goal, inspectedLayouts),
        assertPlanningEvidence: (goal) => {
          assertDashiGoalHasCompleteVisibleCopy(goal, inspectedLayouts);
        },
        prepareGoal: (goal) => dashi.prepareGoal(goal, context.abortSignal),
      });
      tools.push(...planning.tools, proposal.tool);
      captured.push(proposal.getProposal);
    }
    return {
      tools,
      getProposal: () => captured.reduce<PiCapturedProposal | null>(
        (found, read) => found ?? read(),
        null,
      ),
    };
  }

  toolsForSemester(
    context: SemesterFrameworkAgentContext,
    plan: CapabilityPlan,
    surface: ToolSurface,
  ) {
    const proposal = surface === "write"
      ? createPiSemesterProposalTool({ repository: this.repository, context, plan })
      : null;
    return {
      tools: [
        ...createPiSemesterReadTools(this.repository, {
          ownerId: context.userId,
          notebookId: context.notebookId,
          semesterFrameworkId: context.semesterFrameworkId,
        }),
        ...(plan.curriculumRequested ? createPiCurriculumTools(this.repository, context) : []),
        ...(plan.mcpServers.includes("web") ? this.sessionWebTools(context.userId, context.runId) : []),
        ...createPiSpecialistTools(this.repository, context, plan),
        ...(proposal ? [proposal.tool] : []),
      ],
      getProposal: proposal?.getProposal ?? (() => null),
    };
  }

}
