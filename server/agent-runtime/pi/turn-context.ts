import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AgentRunEvidenceKind,
  type CapabilityPlan,
  type LessonAgentContext,
  type LessonAgentSelection,
  type SemesterFrameworkAgentContext,
  type SourceRef,
} from "../../domain.js";
import { dashiThemeCatalogForPrompt } from "../../presentations/dashi-theme-catalog.js";
import type { ToolSurface } from "../../conversation/turn-resolver.js";
import type { PiCapturedProposal } from "./proposal-tools.js";

const MAX_PRELOADED_SELECTION_CHARS = 2_400;

export function selectionTurnHint(selection?: LessonAgentSelection) {
  if (!selection) return null;
  if (selection.text.length <= MAX_PRELOADED_SELECTION_CHARS) {
    return { ...selection, preloaded: true };
  }
  return {
    field: selection.field,
    start: selection.start,
    end: selection.end,
    preloaded: false,
    originalLength: selection.text.length,
  };
}

export function lessonTurnContext(
  context: LessonAgentContext,
  attachments: SourceRef[],
  plan: CapabilityPlan,
  toolSurface: ToolSurface,
  presentationRequest?: string,
  recentPresentationDesigns: Array<{ theme: string; layouts: string[] }> = [],
) {
  const fast = plan.executionLane === "fast";
  const readOnly = toolSurface === "read";
  return {
    resource: { type: "lesson_file", version: context.documentVersion },
    focus: { sectionId: context.activeSectionId },
    selection: selectionTurnHint(context.selection),
    attachments: attachments.map((source) => ({ id: source.id, title: source.title })),
    policy: {
      mode: plan.lightweightConversation ? "lightweight"
        : plan.presentationRequested && plan.presentationThemeConfirmationRequired
          ? "presentation_theme_confirmation"
        : fast
          ? "fast"
        : readOnly
          ? "agent_read"
        : plan.presentationRequested
          ? "presentation"
        : plan.writeMode,
      allowedWriteFields: readOnly ? null : plan.requestedDocumentFields ?? null,
      evidence: {
        required: plan.evidenceRequired,
        kinds: plan.requiredEvidenceKinds ?? [],
        instruction: plan.taskIntent?.type === "decision_proposal"
          ? "Retrieve available evidence and distinguish document-design observations from student outcomes. Missing required sources must be named in uncertainties and saved via propose_decision with status insufficient_evidence; an evidence-gap candidate records an unresolved judgment, not approval to change the lesson. Never fabricate sources or treat synthetic observations as real classroom evidence. Do not call complete_without_change for this task."
          : "Required evidence must be retrieved before drafting a proposal. An empty search is not evidence for a write. If required sources are unavailable, read the canonical document and call complete_without_change with kind insufficient_evidence and the specific missing sources; do not repeat the same empty searches or submit unsupported proposals.",
      },
      taskIntent: plan.taskIntent,
      ...(plan.taskIntent?.type === "decision_proposal" ? {
        decision: {
          instruction: "先读取当前教案与 read_decision_context；提出决策候选时必须给出问题、选项与取舍、可定位证据、反例、假设、不确定性、置信度、预期信号与证伪条件。教案原文足以支持目标与评价是否对齐的设计判断，可标 proposed 并明确它只是待教师审阅的设计假设；不能据此声称学生学习已改善。对于学生表现、方案效果或迁移等缺少观察的判断，提交 insufficient_evidence 并列出缺口。合成观察引用必须保留合成标注且证据卡 level=synthetic，不得升级为一手课堂证据。引用使用工具提供的来源标识、版本与时间，excerpt 逐字引用原文，不拼接推断。无所选项时 chosenOptionId 使用 JSON null，不写字符串。不得替教师确认、实施或审议。",
        },
      } : {}),
      alternativeCompletion: plan.taskIntent?.type === "decision_proposal"
        ? "propose_decision with decisionType no_change or status insufficient_evidence; never complete_without_change"
        : "complete_without_change after reading canonical content when no change is justified or evidence is insufficient",
      completion: plan.taskIntent?.type === "decision_proposal" ? "propose_decision_or_explain_gap"
        : plan.taskIntent?.type === "learning_inquiry" ? "propose_learning_inquiry_or_explain_gap"
        : plan.taskIntent?.type === "learning_review" ? "propose_learning_review_or_explain_gap"
        : plan.lightweightConversation
        ? plan.presentationThemeDismissed ? "dismiss_presentation_theme" : "brief_reply_only"
        : plan.presentationRequested && plan.presentationThemeConfirmationRequired
          ? "ask_presentation_theme"
        : fast
            ? "short_reply"
        : readOnly
          ? "analysis_only"
        : plan.presentationRequested
          ? "propose_classroom_presentation"
          : plan.writeMode === "explicit"
            ? "propose_document_patch"
            : plan.writeMode === "consultative"
              ? "analysis_only"
              : "reply_or_propose_document_patch",
      attachmentReadRequired: attachments.length > 0,
      ...(plan.presentationThemeDismissed ? {
        controlInstruction: "The previous theme question was not answered with a theme or explicit delegation. State briefly that no presentation generation was started. Do not promise future work, recommend a theme, ask again, or continue the previous task.",
      } : {}),
      ...(plan.presentationRequested ? {
        presentation: {
          originalRequest: presentationRequest ?? null,
          confirmedTheme: plan.confirmedPresentationTheme ?? null,
          themeChoiceDelegated: !plan.confirmedPresentationTheme && !plan.presentationThemeConfirmationRequired,
          availableThemes: dashiThemeCatalogForPrompt(),
          instruction: plan.presentationThemeConfirmationRequired
            ? "Ask the teacher to select one theme by ID/name, or explicitly delegate the choice. The client renders the durable theme picker from this state, so keep the reply to one short sentence and do not enumerate themes. Do not read the lesson or start presentation work in this turn."
            : "Use the confirmed theme exactly; if delegated, select one suitable theme from the catalog.",
          recentAccountDesigns: recentPresentationDesigns,
          noveltyPolicy: "Recent designs are account-scoped hints, not content. When semantic fit is equal, avoid repeating their theme and exact layout set; never sacrifice classroom function merely to be different.",
        },
      } : {}),
    },
  };
}

export function semesterTurnContext(
  context: SemesterFrameworkAgentContext,
  plan: CapabilityPlan,
  toolSurface: ToolSurface,
) {
  const readOnly = toolSurface === "read";
  return {
    resource: { type: "semester_framework", version: context.frameworkVersion },
    focus: { unitId: context.activeUnitId ?? null },
    policy: {
      mode: plan.lightweightConversation ? "lightweight" : plan.executionLane === "fast" ? "fast" : readOnly ? "agent_read" : plan.writeMode,
      completion: plan.lightweightConversation
        ? "brief_reply_only"
        : plan.executionLane === "fast"
          ? "short_reply"
        : readOnly
          ? "analysis_only"
        : plan.writeMode === "explicit"
          ? "propose_semester_framework_patch"
          : plan.writeMode === "consultative"
            ? "analysis_only"
            : "reply_or_propose_semester_framework_patch",
    },
  };
}

export function emptyRuntimeTools(): {
  tools: AgentTool<any>[];
  getProposal: () => PiCapturedProposal | null;
  getEvidenceAttempts: () => ReadonlySet<AgentRunEvidenceKind>;
  getNoChange: () => null;
  getLearningProposal: () => null;
  getDecisionProposal: () => null;
} {
  return { tools: [], getProposal: () => null, getNoChange: () => null, getLearningProposal: () => null,
    getDecisionProposal: () => null, getEvidenceAttempts: () => new Set() };
}

export function isFastExecution(
  plan: CapabilityPlan,
  input: { generationIntentId?: string; frameworkWritebackIntentId?: string; attachmentIds?: string[] },
  continuationRun: { status: string } | null,
) {
  return !continuationRun
    && !input.generationIntentId
    && !input.frameworkWritebackIntentId
    && (input.attachmentIds?.length ?? 0) === 0
    && (
      plan.executionLane === "fast"
      || (plan.presentationRequested && plan.presentationThemeConfirmationRequired)
    );
}
