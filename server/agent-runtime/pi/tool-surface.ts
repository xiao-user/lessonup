import { withTeachingCompletion } from "./teaching-completion.js";
import { createPiLearningTools } from "./learning-tools.js";
import { type CapabilityPlan, type LessonAgentContext, type SemesterFrameworkAgentContext } from "../../domain.js";
import type { LessonRepository } from "../../repository.js";
import { SkillRegistry, type PlatformSkill } from "../../agent/skill-registry.js";
import { type DashiThemeId } from "../../presentations/dashi-theme-catalog.js";
import type { WebSearchProvider } from "../../providers/web-search.js";
import type { QueryEmbedder } from "../../providers/query-embedding.js";
import { UnavailableWebSearchProvider } from "../../providers/unavailable-web-search.js";
import { createPiDashiPlanningSession } from "./dashi-tools.js";
import { assertDashiGoalHasCompleteVisibleCopy, indexDashiLayoutContracts, keepOnlyDashiAuthoredContent, type DashiLayoutContract } from "../../presentations/dashi-layout-contract.js";
import { createPiLessonKnowledgeTools, createPiLessonReadTools } from "./lesson-tools.js";
import { createPiDocumentProposalTool, createPiDesignBasisPatchProposalTool, createPiDesignBasisProjectionProposalTool, createPiLessonDesignChangeProposalTool, createPiPresentationProposalTool, createPiSemesterProposalTool, type PiCapturedProposal } from "./proposal-tools.js";
import { createPiSemesterReadTools } from "./semester-tools.js";
import { createPiCurriculumTools } from "./curriculum-tools.js";
import { createPiDesignBasisReadTools } from "./design-basis-tools.js";
import { createPiWebTools } from "./web-tools.js";
import { trackEvidenceAttempts } from "./evidence-attempts.js";
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
    /** Embeds search queries so retrieval can rank by meaning; absent means lexical only. */
    private readonly embedQuery?: QueryEmbedder,
  ) {}
  /** Teaching judgment is always available; only Dashi needs a separate Skill. */
  skillsForSurface(plan: CapabilityPlan, _surface: ToolSurface) {
    return plan.presentationRequested && this.dashi ? this.registry.resolve(["dashi-ppt"]) : [];
  }

  private sessionWebTools(repository: LessonRepository, ownerId: string, runId: string) {
    if (this.webProvider instanceof UnavailableWebSearchProvider) return [];
    return createPiWebTools({
      repository,
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
    const { repository, attempts } = trackEvidenceAttempts(this.repository);
    const scope = {
      ownerId: context.userId,
      notebookId: context.notebookId,
      lessonFileId: context.lessonFileId,
      runId: context.runId,
      allowedKnowledgeScopes: context.allowedKnowledgeScopes,
      attachmentSourceIds: context.attachmentSourceIds,
    };
    const writing = surface === "write";
    // Scope binds authority. Language routing can require evidence or restrict
    // writes, but must not hide the tools needed to investigate a hypothesis.
    // The content-only Dashi workflow keeps its own compact surface.
    const teaching = !plan.presentationRequested;
    // The approval-gated document proposal is part of the stable Agent tool
    // surface. Per-turn policy decides whether it may succeed; removing the
    // schema on consultation turns invalidated the provider's transcript cache.
    const learning = createPiLearningTools(repository, context, plan);
    const document = createPiDocumentProposalTool({ repository, context, plan });
    const tools = [
      ...(skills.length ? [createPiReadSkillTool(skills)] : []),
      ...createPiLessonReadTools(repository, scope, {
        requireCompleteDocument: plan.presentationRequested && !plan.presentationThemeConfirmationRequired,
      }),
      ...(teaching ? createPiLessonKnowledgeTools(repository, scope, this.embedQuery) : []),
      ...(teaching ? createPiCurriculumTools(repository, context, this.embedQuery) : []),
      ...(teaching ? createPiDesignBasisReadTools(repository, context) : []),
      ...(teaching ? this.sessionWebTools(repository, context.userId, context.runId) : []),
      ...(teaching ? learning.tools : []),
      document.tool,
    ];
    const captured: Array<() => PiCapturedProposal | null> = [document.getProposal];
    if (writing && plan.designBasisWriteRequested) {
      const basis = createPiDesignBasisPatchProposalTool({ repository, context });
      const combined = createPiLessonDesignChangeProposalTool({
        repository,
        context,
        plan,
      });
      const projection = createPiDesignBasisProjectionProposalTool({
        repository,
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
        repository,
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
    const getProposal = () => captured.reduce<PiCapturedProposal | null>((found, read) => found ?? read(), null);
    const completion = teaching ? withTeachingCompletion(tools, () => Boolean(getProposal() || learning.getLearningProposal())) : null;
    return {
      tools: completion?.tools ?? tools,
      getProposal,
      getLearningProposal: learning.getLearningProposal,
      getNoChange: completion?.getNoChange ?? (() => null),
      getEvidenceAttempts: () => attempts,
    };
  }

  toolsForSemester(
    context: SemesterFrameworkAgentContext,
    plan: CapabilityPlan,
    _surface: ToolSurface,
  ) {
    const { repository, attempts } = trackEvidenceAttempts(this.repository);
    // Like the lesson proposal, the stable schema is approval-gated and checks
    // this turn's write policy in the tool rather than changing the prefix.
    const proposal = createPiSemesterProposalTool({ repository, context, plan });
    const tools = [
        ...createPiSemesterReadTools(repository, {
          ownerId: context.userId,
          notebookId: context.notebookId,
          semesterFrameworkId: context.semesterFrameworkId,
        }),
        ...createPiCurriculumTools(repository, context, this.embedQuery),
        ...this.sessionWebTools(repository, context.userId, context.runId),
        proposal.tool,
      ];
    const completion = withTeachingCompletion(tools, () => Boolean(proposal.getProposal()));
    return {
      ...completion,
      getLearningProposal: () => null,
      getProposal: proposal.getProposal,
      getEvidenceAttempts: () => attempts,
    };
  }

}
