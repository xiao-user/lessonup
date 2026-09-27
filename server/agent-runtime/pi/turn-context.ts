import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
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
      completion: plan.lightweightConversation
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
} {
  return { tools: [], getProposal: () => null };
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
