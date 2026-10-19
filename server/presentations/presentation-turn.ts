import type { AgentPendingInteraction, CapabilityPlan } from "../domain.js";
import {
  cancelsDashiThemeChoice,
  dashiThemeCatalog,
  delegatesDashiThemeChoice,
  parseDashiTheme,
  type DashiThemeId,
} from "./dashi-theme-catalog.js";

const presentationReference = /(?:课堂)?(?:演示文稿|演示稿|演示|幻灯片|课件|PPT|Dashi)/i;
// Complete control utterances, not verbs found inside ordinary discussion.
const resumeRequest = /^(?:请|麻烦你|帮我)?\s*(?:继续(?:做|生成|制作|完成)?|接着(?:做|生成|制作|完成)?|重试|(?:重新|再)(?:试试|试一次|试一下|尝试|生成|制作|做一次)|retry|resume)(?:\s*(?:刚才|之前|上次|这个|当前|原来)?的?(?:课堂演示文稿|课堂演示|演示文稿|演示稿|演示|幻灯片|课件|PPT|Dashi|任务))?(?:吧|一下)?[。！!\s]*$/iu;

/** Persisted on the owning branch, never inferred from assistant prose. */
export type PendingPresentationInteraction = AgentPendingInteraction & {
  resourceId?: string;
  // After unrelated discussion a bare “继续” could refer to that discussion.
  resumeReferenceRequired?: boolean;
};

/** Dashi supports Chinese and English; bind it from the teacher's request. */
export function presentationLanguageForRequest(value: string): "zh" | "en" | undefined {
  const semanticText = value.replace(/\b(?:ppt|dashi|theme\d*)\b/giu, "");
  const hanCount = semanticText.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latinCount = semanticText.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (!hanCount && !latinCount) return undefined;
  return hanCount * 2 >= latinCount ? "zh" : "en";
}

function isThemeChoiceReply(message: string, theme: DashiThemeId | null): boolean {
  if (!theme) return false;
  let remainder = message.replace(/theme[\s_-]*(?:1[0-2]|0?[1-9])(?![a-z0-9])/giu, "");
  for (const item of dashiThemeCatalog) remainder = remainder.replaceAll(item.name, "");
  remainder = remainder.replace(/^[\s]*(?:0?[1-9]|1[0-2])[\s]*$/u, "")
    .replace(/[\s（）()：:，,。！!]/gu, "");
  return /^(?:请)?(?:我选择|我选|选择|选用|使用|就用|用|确认主题|确认风格|确认|主题|风格)?(?:吧|即可|就行)?$/u.test(remainder);
}

function isDelegatedThemeReply(message: string): boolean {
  return /^(?:主题|风格)?(?:请)?(?:你来|由你|自动)(?:决定|选择|选|匹配)(?:一个)?(?:合适的?)?(?:主题|风格)?(?:即可|就行|吧)?[。！!\s]*$/u.test(message.trim())
    || /^(?:都可以|随意|不挑|合适即可|合适就行)[。！!\s]*$/u.test(message.trim());
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
  resourceId?: string,
): PendingPresentationInteraction {
  return {
    kind, originalRequest, documentVersion, requestedAt, confirmedTheme,
    ...(resourceId === undefined ? {} : { resourceId }),
  };
}

export type PresentationTurnResolution = {
  plan: CapabilityPlan;
  presentationRequest: string;
  pendingInteraction: PendingPresentationInteraction | null;
  /** An explicit recovery referred to a task from another resource/version. */
  expiredInteraction?: true;
};

/**
 * The branch owns a recoverable task until delivery or explicit cancellation.
 * Ordinary discussion suspends it without resuming it. Recovery requires an
 * explicit action and the exact resource/document snapshot.
 */
export function resolvePresentationTurn(input: {
  message: string;
  routedPlan: CapabilityPlan;
  pendingInteraction?: PendingPresentationInteraction | null;
  documentVersion: number;
  resourceId?: string;
  now?: string;
}): PresentationTurnResolution {
  const now = input.now ?? new Date().toISOString();
  const selectedTheme = parseDashiTheme(input.message);
  const choiceReply = isThemeChoiceReply(input.message, selectedTheme);
  const delegatedReply = isDelegatedThemeReply(input.message);
  const cancelled = cancelsDashiThemeChoice(input.message);
  const resume = resumeRequest.test(input.message.trim());
  const previous = input.pendingInteraction;
  // Resource-less legacy state is safe only for resource-less callers. The
  // coordinator must pass the canonical lesson id.
  const currentPending = previous
    && previous.documentVersion === input.documentVersion
    && previous.resourceId === input.resourceId
    ? previous
    : null;

  // Recovery controls are whole replies; a complete new presentation request
  // is resolved below against the current resource/version instead.
  const recoveryRequested = resume || choiceReply || delegatedReply;
  if (previous && !currentPending && recoveryRequested) {
    return {
      plan: input.routedPlan,
      presentationRequest: input.message,
      pendingInteraction: null,
      expiredInteraction: true,
    };
  }

  if (currentPending && cancelled) {
    return { plan: dismissedPlan(input.routedPlan), presentationRequest: input.message, pendingInteraction: null };
  }

  const referencedResume = resume && (!currentPending?.resumeReferenceRequired || presentationReference.test(input.message));
  const continuePending = currentPending && (choiceReply || delegatedReply
    || (currentPending.kind === "presentation_generation" && referencedResume));
  if (continuePending) {
    const theme = (choiceReply ? selectedTheme : currentPending.confirmedTheme) as DashiThemeId | undefined;
    return {
      plan: presentationPlan(input.routedPlan, theme),
      presentationRequest: currentPending.originalRequest,
      pendingInteraction: pending(
        "presentation_generation", currentPending.originalRequest, input.documentVersion,
        currentPending.requestedAt, theme, input.resourceId,
      ),
    };
  }

  // Merely mentioning a theme in a question is not authorization to generate.
  if (!input.routedPlan.presentationRequested) {
    return {
      plan: input.routedPlan,
      presentationRequest: input.message,
      pendingInteraction: currentPending ? { ...currentPending, resumeReferenceRequired: true } : null,
    };
  }

  if (selectedTheme || delegatesDashiThemeChoice(input.message)) {
    return {
      plan: presentationPlan(input.routedPlan, selectedTheme ?? undefined),
      presentationRequest: input.message,
      pendingInteraction: pending(
        "presentation_generation", input.message, input.documentVersion, now,
        selectedTheme ?? undefined, input.resourceId,
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
    pendingInteraction: pending("presentation_theme", input.message, input.documentVersion, now, undefined, input.resourceId),
  };
}
