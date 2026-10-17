import type { AgentPendingInteraction, CapabilityPlan } from "../domain.js";
import {
  cancelsDashiThemeChoice,
  delegatesDashiThemeChoice,
  parseDashiTheme,
  type DashiThemeId,
} from "./dashi-theme-catalog.js";

const retryPattern = /^(?:继续|接着|重试|再试一次|重新生成|retry)[。！!\s]*$/i;

/** Dashi supports Chinese and English; bind it from the teacher's request. */
export function presentationLanguageForRequest(value: string): "zh" | "en" | undefined {
  const semanticText = value.replace(/\b(?:ppt|dashi|theme\d*)\b/giu, "");
  const hanCount = semanticText.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latinCount = semanticText.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (!hanCount && !latinCount) return undefined;
  return hanCount * 2 >= latinCount ? "zh" : "en";
}

function presentationPlan(plan: CapabilityPlan, theme?: DashiThemeId): CapabilityPlan {
  return {
    ...plan,
    presentationRequested: true,
    presentationThemeConfirmationRequired: false,
    presentationThemeDismissed: false,
    confirmedPresentationTheme: theme,
    skillIds: ["dashi-ppt"],
    toolGroups: ["presentation-create"],
    mcpServers: [],
    writeMode: "consultative",
    lightweightConversation: false,
    executionLane: "agent",
    requestedDocumentFields: undefined,
  };
}

function dismissedPlan(plan: CapabilityPlan): CapabilityPlan {
  return {
    ...plan,
    presentationRequested: false,
    presentationThemeConfirmationRequired: false,
    presentationThemeDismissed: true,
    confirmedPresentationTheme: undefined,
    skillIds: [],
    toolGroups: [],
    mcpServers: [],
    lightweightConversation: true,
    executionLane: "fast",
  };
}

function pending(
  kind: AgentPendingInteraction["kind"],
  originalRequest: string,
  documentVersion: number,
  requestedAt: string,
  confirmedTheme?: DashiThemeId,
): AgentPendingInteraction {
  return { kind, originalRequest, documentVersion, requestedAt, confirmedTheme };
}

export type PresentationTurnResolution = {
  plan: CapabilityPlan;
  presentationRequest: string;
  pendingInteraction: AgentPendingInteraction | null;
};

/**
 * Resolve the presentation conversation protocol before Pi tools are built.
 * A theme choice belongs to the teacher's presentation request, even if the
 * editor saves a newer document snapshot while the teacher is choosing. A
 * generation retry still belongs to the exact document snapshot it started on.
 * Ordinary conversation never resumes presentation generation implicitly.
 */
export function resolvePresentationTurn(input: {
  message: string;
  routedPlan: CapabilityPlan;
  pendingInteraction?: AgentPendingInteraction | null;
  documentVersion: number;
  now?: string;
}): PresentationTurnResolution {
  const now = input.now ?? new Date().toISOString();
  const selectedTheme = parseDashiTheme(input.message);
  const delegated = delegatesDashiThemeChoice(input.message);
  const cancelled = cancelsDashiThemeChoice(input.message);
  const currentPending = (input.pendingInteraction?.kind === "presentation_theme"
    || input.pendingInteraction?.documentVersion === input.documentVersion)
    ? input.pendingInteraction
    : null;

  if (currentPending?.kind === "presentation_generation") {
    if (cancelled) {
      return { plan: dismissedPlan(input.routedPlan), presentationRequest: input.message, pendingInteraction: null };
    }
    if (retryPattern.test(input.message.trim()) || selectedTheme || delegated) {
      const theme = selectedTheme ?? currentPending.confirmedTheme as DashiThemeId | undefined;
      return {
        plan: presentationPlan(input.routedPlan, theme),
        presentationRequest: currentPending.originalRequest,
        pendingInteraction: pending(
          "presentation_generation",
          currentPending.originalRequest,
          input.documentVersion,
          currentPending.requestedAt,
          theme,
        ),
      };
    }
    return { plan: input.routedPlan, presentationRequest: input.message, pendingInteraction: null };
  }

  if (currentPending?.kind === "presentation_theme") {
    if (cancelled) {
      return { plan: dismissedPlan(input.routedPlan), presentationRequest: input.message, pendingInteraction: null };
    }
    if (selectedTheme || delegated) {
      return {
        plan: presentationPlan(input.routedPlan, selectedTheme ?? undefined),
        presentationRequest: currentPending.originalRequest,
        pendingInteraction: pending(
          "presentation_generation",
          currentPending.originalRequest,
          input.documentVersion,
          currentPending.requestedAt,
          selectedTheme ?? undefined,
        ),
      };
    }
    return { plan: dismissedPlan(input.routedPlan), presentationRequest: input.message, pendingInteraction: null };
  }

  if (!input.routedPlan.presentationRequested) {
    return { plan: input.routedPlan, presentationRequest: input.message, pendingInteraction: null };
  }

  if (selectedTheme || delegated) {
    return {
      plan: presentationPlan(input.routedPlan, selectedTheme ?? undefined),
      presentationRequest: input.message,
      pendingInteraction: pending(
        "presentation_generation",
        input.message,
        input.documentVersion,
        now,
        selectedTheme ?? undefined,
      ),
    };
  }

  return {
    plan: {
      ...input.routedPlan,
      presentationRequested: true,
      presentationThemeConfirmationRequired: true,
      presentationThemeDismissed: false,
      confirmedPresentationTheme: undefined,
      skillIds: [],
      toolGroups: [],
      mcpServers: [],
      writeMode: "consultative",
      executionLane: "agent",
    },
    presentationRequest: input.message,
    pendingInteraction: pending(
      "presentation_theme",
      input.message,
      input.documentVersion,
      now,
    ),
  };
}
